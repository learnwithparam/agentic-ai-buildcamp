// Approvals and memory live in Postgres, so a restart loses nothing.
// A report that needs a person pauses a LangGraph run. The run waits in a checkpoint.
// A person with the approves grant decides. Only then does the run send the reply.
import { randomUUID } from "node:crypto";
import { type Spec, validateSpec } from "@json-render/core";
import { Annotation, Command, END, interrupt, START, StateGraph } from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { PostgresStore } from "@langchain/langgraph-checkpoint-postgres/store";
import { personNamed } from "../../../data/catalog/people";
import { DATABASE_URL, inTransaction, rows } from "./db";

export type Status = "pending" | "approved" | "rejected";
export type Approval = {
  id: number;
  requester: string;
  topic: string;
  question: string;
  status: Status;
  decided_by: string | null;
  thread_id: string;
};
export type Decision = { approved: boolean; approver: string };

const TOPIC = "adverse-events";
const CHECKPOINT_SCHEMA = "approvals_graph";
const MEMORY_SCHEMA = "approvals_memory";

const TABLES = `
  CREATE TABLE IF NOT EXISTS pending_approvals (id serial PRIMARY KEY, requester text, topic text,
    question text, status text DEFAULT 'pending', decided_by text, thread_id text,
    created timestamptz DEFAULT clock_timestamp());
  CREATE TABLE IF NOT EXISTS outbox (approval_id int, body text, sent_by text)`;

export async function setupTables(): Promise<void> {
  await rows(TABLES);
}

// The ApprovalCard is one json-render spec. The web and the CLI both draw it from this data.
export function approvalCard(approval: Approval): Spec {
  const spec: Spec = {
    root: "card",
    elements: {
      card: {
        type: "Card",
        props: {
          title: `Approval ${approval.id}`,
          description: `Asked by ${approval.requester}`,
          maxWidth: "md",
          centered: null,
          className: null,
        },
        children: ["question", "buttons"],
      },
      question: { type: "Text", props: { text: approval.question, variant: "body" }, children: [] },
      buttons: {
        type: "Stack",
        props: { direction: "horizontal", gap: "sm", align: null, justify: null, className: null },
        children: ["approve", "reject"],
      },
      approve: {
        type: "Button",
        props: { label: "Approve", variant: "primary", disabled: null },
        on: { press: { action: "decide", params: { id: approval.id, approved: true } } },
        children: [],
      },
      reject: {
        type: "Button",
        props: { label: "Reject", variant: "danger", disabled: null },
        on: { press: { action: "decide", params: { id: approval.id, approved: false } } },
        children: [],
      },
    },
  };
  const found = validateSpec(spec);
  if (!found.valid)
    throw new Error(`The approval card is not a valid spec: ${found.issues[0]?.message}`);
  return spec;
}

// The CLI draws the same spec as plain text: each text and each button, in order.
type Props = Record<string, unknown>;
const LINE = new Map<string, (props: Props) => string>([
  ["Card", (props) => `${props.title} (${props.description})`],
  ["Text", (props) => String(props.text)],
  ["Button", (props) => `[${props.label}]`],
]);

export function cardText(spec: Spec): string {
  const lines: string[] = [];
  const walk = (key: string): void => {
    const element = spec.elements[key];
    if (element === undefined) return;
    const line = LINE.get(element.type)?.(element.props as Props);
    if (line !== undefined) lines.push(line);
    for (const child of element.children ?? []) walk(child);
  };
  walk(spec.root);
  return lines.join("\n");
}

// #region step:approvals-memory
const ReviewState = Annotation.Root({
  approvalId: Annotation<number>(),
  question: Annotation<string>(),
  decision: Annotation<Decision | null>(),
});

// The node that waits. interrupt() saves the run in Postgres and stops until a person resumes it.
async function waitForPerson(state: typeof ReviewState.State) {
  const payload = { approvalId: state.approvalId, question: state.question };
  const decision = interrupt(payload) as Decision;
  return { decision };
}

// One decision, once. The row changes only while pending. A reply goes out only on yes.
async function sendReply(state: typeof ReviewState.State) {
  const decision = state.decision as Decision;
  await inTransaction(async (run) => {
    const status = decision.approved ? "approved" : "rejected";
    const changed = await run(
      `UPDATE pending_approvals SET status = $2, decided_by = $3
       WHERE id = $1 AND status = 'pending'`,
      [state.approvalId, status, decision.approver],
    );
    if (changed.rowCount === 0 || !decision.approved) return;
    const body = `Reply sent for: ${state.question}`;
    await run("INSERT INTO outbox VALUES ($1, $2, $3)", [
      state.approvalId,
      body,
      decision.approver,
    ]);
  });
  return {};
}

type Engine = {
  saver: PostgresSaver;
  store: PostgresStore;
  graph: ReturnType<typeof buildGraph>;
};
let engine: Promise<Engine> | undefined;

function buildGraph(saver: PostgresSaver) {
  return new StateGraph(ReviewState)
    .addNode("wait", waitForPerson)
    .addNode("send", sendReply)
    .addEdge(START, "wait")
    .addEdge("wait", "send")
    .addEdge("send", END)
    .compile({ checkpointer: saver });
}

async function start(): Promise<Engine> {
  await setupTables();
  const saver = PostgresSaver.fromConnString(DATABASE_URL, { schema: CHECKPOINT_SCHEMA });
  await saver.setup();
  const store = PostgresStore.fromConnString(DATABASE_URL, { schema: MEMORY_SCHEMA });
  await store.setup();
  return { saver, store, graph: buildGraph(saver) };
}

function running(): Promise<Engine> {
  engine ??= start();
  return engine;
}

// A restart in a test: close the graph and the memory. The next call opens them again.
export async function stopApprovals(): Promise<void> {
  const open = engine;
  engine = undefined;
  if (open === undefined) return;
  const { saver, store } = await open;
  await saver.end();
  await store.stop();
}

export async function resetApprovals(): Promise<void> {
  await stopApprovals();
  await rows(`DROP SCHEMA IF EXISTS ${CHECKPOINT_SCHEMA}, ${MEMORY_SCHEMA} CASCADE`);
  await rows("DROP TABLE IF EXISTS pending_approvals, approvals, outbox, memories");
  await setupTables();
}

// Saves the report in the inbox, then starts a run that stops at interrupt().
export async function requestApproval(requester: string, question: string): Promise<number> {
  const { graph } = await running();
  const thread = randomUUID();
  const [row] = await rows<{ id: number }>(
    `INSERT INTO pending_approvals (requester, topic, question, thread_id)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [requester, TOPIC, question, thread],
  );
  await graph.invoke(
    { approvalId: row.id, question, decision: null },
    { configurable: { thread_id: thread } },
  );
  return row.id;
}

export async function pendingFor(approver: string): Promise<Approval[]> {
  await running();
  return rows<Approval>(
    `SELECT * FROM pending_approvals a WHERE a.status = 'pending' AND EXISTS (
       SELECT 1 FROM grants g
       WHERE g.person = $1 AND g.relation = 'approves' AND g.object = a.topic)
     ORDER BY a.id`,
    [approver],
  );
}

// The same inbox as cards. The web draws each card. The CLI prints it with cardText.
export async function cardsFor(approver: string): Promise<Spec[]> {
  return (await pendingFor(approver)).map(approvalCard);
}

// Only a person with the approves grant may decide. Only a waiting row can be decided.
export async function decide(id: number, approver: string, approved: boolean): Promise<Status> {
  const { graph } = await running();
  const found = await rows<Approval>(
    "SELECT * FROM pending_approvals WHERE id = $1 AND status = 'pending'",
    [id],
  );
  if (found.length === 0) throw new Error(`Approval ${id} is not waiting.`);
  const grant = await rows(
    "SELECT 1 FROM grants WHERE person = $1 AND relation = 'approves' AND object = $2",
    [approver, found[0].topic],
  );
  if (grant.length === 0) throw new Error(`${approver} may not decide ${found[0].topic}.`);
  const resume = new Command<Decision, Record<string, unknown>, "wait" | "send">({
    resume: { approved, approver },
  });
  await graph.invoke(resume, { configurable: { thread_id: found[0].thread_id } });
  return approved ? "approved" : "rejected";
}

// A button press on the card. The web calls this when a reviewer clicks Approve or Reject.
export async function pressCard(spec: Spec, button: string, approver: string): Promise<Status> {
  const binding = spec.elements[button]?.on?.press;
  const params = (Array.isArray(binding) ? binding[0] : binding)?.params;
  if (params === undefined) throw new Error(`The card has no button named ${button}.`);
  return decide(Number(params.id), approver, params.approved === true);
}

// The CLI: "list <person>", "approve <id> <person>" or "reject <id> <person>". It returns text.
export async function approvalsCli(argv: string[]): Promise<string> {
  const [command, first, second] = argv;
  if (command === "list")
    return (await cardsFor(first)).map(cardText).join("\n\n") || "Inbox is empty.";
  if (command !== "approve" && command !== "reject") throw new Error(`Unknown command: ${command}`);
  const status = await decide(Number(first), second, command === "approve");
  return `Approval ${first} is ${status}.`;
}

// Notes stay with one person. The namespace is the company, then the person.
export async function remember(person: string, note: string): Promise<void> {
  const owner = personNamed(person);
  const { store } = await running();
  await store.put([owner.tenant, owner.name], randomUUID(), { note, at: Date.now() });
}

export async function recallFor(tenant: string, person: string): Promise<string[]> {
  const { store } = await running();
  const found = await store.search([tenant, person], { limit: 100 });
  const sorted = found.sort((first, second) => Number(first.value.at) - Number(second.value.at));
  return sorted.map((item) => String(item.value.note));
}

export async function recall(person: string): Promise<string[]> {
  const owner = personNamed(person);
  return recallFor(owner.tenant, owner.name);
}
// #stub
//~ // TODO(approvals-memory): pause with interrupt(), let an approver decide once, keep notes
//~ export async function requestApproval(_requester: string, _question: string): Promise<number> {
//~   return 0;
//~ }
//~
//~ export async function pendingFor(_approver: string): Promise<Approval[]> {
//~   return [];
//~ }
//~
//~ export async function decide(_id: number, _who: string, _yes: boolean): Promise<Status> {
//~   return "pending";
//~ }
//~
//~ export async function remember(_person: string, _note: string): Promise<void> {}
//~
//~ export async function recall(_person: string): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function recallFor(_tenant: string, _person: string): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function cardsFor(_approver: string): Promise<Spec[]> {
//~   return [];
//~ }
//~
//~ export async function pressCard(_spec: Spec, _button: string, _who: string): Promise<Status> {
//~   return "pending";
//~ }
//~
//~ export async function approvalsCli(_argv: string[]): Promise<string> {
//~   return "";
//~ }
//~
//~ export async function stopApprovals(): Promise<void> {}
//~
//~ export async function resetApprovals(): Promise<void> {}
// #endregion

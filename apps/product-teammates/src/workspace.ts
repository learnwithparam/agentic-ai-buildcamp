// Workspaces keep teams apart. A person reads a workspace only when a member grant says so.
// Tone notes stay inside one workspace. A briefing waits as a row until an approver decides.
import { join } from "node:path";
import {
  Annotation,
  type BaseCheckpointSaver,
  Command,
  END,
  interrupt,
  START,
  StateGraph,
} from "@langchain/langgraph";
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { WORKSPACES } from "../../../data/catalog/mission-control";
import { DATABASE_URL, inTransaction, rows } from "../../../packages/core/src/db";
import { ROOT } from "../../../scripts/root";
import type { AgentResult } from "../../../src/grade";

const TABLES = `
  CREATE TABLE IF NOT EXISTS tone_notes (id serial PRIMARY KEY, workspace text, person text,
    note text);
  CREATE TABLE IF NOT EXISTS briefings (id serial PRIMARY KEY, writer text, workspace text,
    body text, status text DEFAULT 'pending', approved_by text)`;

export async function setupWorkspace(): Promise<void> {
  await rows(TABLES);
}

export async function resetWorkspace(): Promise<void> {
  await rows("DROP TABLE IF EXISTS tone_notes, briefings");
  await setupWorkspace();
}

function refuse(text: string): AgentResult {
  return { route: "refuse", text, citations: [] };
}

// #region lab:tenancy-and-memory
export async function isMember(person: string, workspace: string): Promise<boolean> {
  const found = await rows(
    "SELECT 1 FROM grants WHERE person = $1 AND relation = 'member' AND object = $2",
    [person, workspace],
  );
  return found.length > 0;
}

export async function homeWorkspace(person: string): Promise<string> {
  const found = await rows<{ object: string }>(
    "SELECT object FROM grants WHERE person = $1 AND relation = 'member' ORDER BY object LIMIT 1",
    [person],
  );
  if (found.length === 0) throw new Error(`${person} belongs to no workspace.`);
  return found[0].object;
}

// The wall comes first. A person outside the workspace never reaches the file.
export async function readMemo(person: string, workspace: string): Promise<string | undefined> {
  if (!(await isMember(person, workspace))) return undefined;
  const file = Bun.file(join(ROOT, ".data", "workspaces", `${workspace}-memo.txt`));
  if (!(await file.exists())) return undefined;
  return (await file.text()).trim();
}

export async function rememberTone(person: string, workspace: string, note: string): Promise<void> {
  await setupWorkspace();
  await rows("INSERT INTO tone_notes (workspace, person, note) VALUES ($1, $2, $3)", [
    workspace,
    person,
    note,
  ]);
}

export async function recallTone(person: string, workspace: string): Promise<string | undefined> {
  await setupWorkspace();
  const found = await rows<{ note: string }>(
    `SELECT note FROM tone_notes WHERE person = $1 AND workspace = $2
     ORDER BY id DESC LIMIT 1`,
    [person, workspace],
  );
  if (found.length === 0) return undefined;
  return found[0].note;
}

export async function submitBriefing(writer: string, workspace: string, body: string) {
  await setupWorkspace();
  const [row] = await rows<{ id: number }>(
    "INSERT INTO briefings (writer, workspace, body) VALUES ($1, $2, $3) RETURNING id",
    [writer, workspace, body],
  );
  return row.id;
}

// One decision, once. The writer can never be the approver.
export async function approveBriefing(id: number, approver: string): Promise<void> {
  await inTransaction(async (run) => {
    const found = await run("SELECT * FROM briefings WHERE id = $1 AND status = 'pending'", [id]);
    if (found.rows.length === 0) throw new Error(`Briefing ${id} is not waiting.`);
    const briefing = found.rows[0] as { writer: string; workspace: string };
    if (briefing.writer === approver)
      throw new Error("A writer cannot approve their own briefing.");
    const grant =
      "SELECT 1 FROM grants WHERE person = $1 AND relation = 'approves' AND object = $2";
    const allowed = await run(grant, [approver, "briefings"]);
    if (allowed.rows.length === 0) throw new Error(`${approver} may not approve briefings.`);
    const update = "UPDATE briefings SET status = 'published', approved_by = $2 WHERE id = $1";
    await run(update, [id, approver]);
  });
}

const WORKSPACE_WALL = `CREATE OR REPLACE FUNCTION app_member(who text, space text)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT EXISTS (SELECT 1 FROM grants WHERE person = who AND relation = 'member' AND object = space)
$$;
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_reader') THEN
    CREATE ROLE app_reader;
  END IF;
END $$;
ALTER TABLE tone_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tone_wall ON tone_notes;
CREATE POLICY tone_wall ON tone_notes FOR SELECT TO app_reader
  USING (person = current_setting('app.person', true)
    AND app_member(current_setting('app.person', true), workspace));
GRANT SELECT ON tone_notes TO app_reader;
ALTER TABLE briefings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS briefing_wall ON briefings;
CREATE POLICY briefing_wall ON briefings FOR SELECT TO app_reader
  USING (app_member(current_setting('app.person', true), workspace));
GRANT SELECT ON briefings TO app_reader`;

// The database is a second wall. It holds even when a query forgets to filter.
export async function applyWorkspaceWalls(): Promise<void> {
  await setupWorkspace();
  await rows(WORKSPACE_WALL);
}

// Seeds the two workspaces. The Titan memo already lives in the catalog, so it is never copied.
export async function seedWorkspaces(): Promise<void> {
  await rows(`CREATE TABLE IF NOT EXISTS workspaces (name text PRIMARY KEY, about text)`);
  for (const space of WORKSPACES) {
    await rows("INSERT INTO workspaces VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [
      space.name,
      space.about,
    ]);
  }
}

// This query names no person and no workspace filter. The policy alone picks the rows.
export async function toneUnderWall(person: string, workspace: string): Promise<string[]> {
  await applyWorkspaceWalls();
  return inTransaction(async (run) => {
    await run("SET LOCAL ROLE app_reader");
    await run("SELECT set_config('app.person', $1, true)", [person]);
    const found = await run("SELECT note FROM tone_notes WHERE workspace = $1 ORDER BY id", [
      workspace,
    ]);
    return found.rows.map((item) => (item as { note: string }).note);
  });
}

export async function briefingsUnderWall(person: string): Promise<string[]> {
  await applyWorkspaceWalls();
  return inTransaction(async (run) => {
    await run("SET LOCAL ROLE app_reader");
    await run("SELECT set_config('app.person', $1, true)", [person]);
    const found = await run("SELECT body FROM briefings ORDER BY id");
    return found.rows.map((item) => (item as { body: string }).body);
  });
}

const BriefingState = Annotation.Root({
  writer: Annotation<string>(),
  workspace: Annotation<string>(),
  body: Annotation<string>(),
  approver: Annotation<string>(),
  status: Annotation<string>(),
});

type Decision = { approver: string; approved: boolean };

// The graph stops at interrupt() and saves its state. A later session resumes the same thread.
function briefingGraph(saver: BaseCheckpointSaver) {
  async function wait(state: typeof BriefingState.State) {
    const answer = interrupt({ ask: "Approve this briefing?", workspace: state.workspace });
    const decision = answer as Decision;
    return { approver: decision.approver, status: decision.approved ? "approved" : "rejected" };
  }
  async function publish(state: typeof BriefingState.State) {
    if (state.status !== "approved") return {};
    const id = await submitBriefing(state.writer, state.workspace, state.body);
    await approveBriefing(id, state.approver);
    return { status: "published" };
  }
  return new StateGraph(BriefingState)
    .addNode("wait", wait)
    .addNode("publish", publish)
    .addEdge(START, "wait")
    .addEdge("wait", "publish")
    .addEdge("publish", END)
    .compile({ checkpointer: saver });
}

export async function postgresSaver(): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(DATABASE_URL);
  await saver.setup();
  return saver;
}

export type Brief = { writer: string; workspace: string; body: string };

// Starts the briefing and stops at the approval. Nothing is published yet.
export async function startBriefing(saver: BaseCheckpointSaver, thread: string, brief: Brief) {
  await setupWorkspace();
  await briefingGraph(saver).invoke(brief, { configurable: { thread_id: thread } });
}

export async function isWaiting(saver: BaseCheckpointSaver, thread: string): Promise<boolean> {
  const state = await briefingGraph(saver).getState({ configurable: { thread_id: thread } });
  return state.next.includes("wait");
}

// Checked before the resume, so a refused person leaves the saved thread untouched.
async function mustBeApprover(thread: string, approver: string, saver: BaseCheckpointSaver) {
  const config = { configurable: { thread_id: thread } };
  const state = await briefingGraph(saver).getState(config);
  if (approver === state.values.writer) {
    throw new Error("A writer cannot approve their own briefing.");
  }
  const grant = "SELECT 1 FROM grants WHERE person = $1 AND relation = 'approves' AND object = $2";
  if ((await rows(grant, [approver, "briefings"])).length === 0) {
    throw new Error(`${approver} may not approve briefings.`);
  }
}

// A fresh graph and a fresh call. Only the saved thread links it to the first session.
export async function resumeBriefing(
  saver: BaseCheckpointSaver,
  thread: string,
  decision: Decision,
): Promise<string> {
  await mustBeApprover(thread, decision.approver, saver);
  const config = { configurable: { thread_id: thread } };
  const done = await briefingGraph(saver).invoke(new Command({ resume: decision }), config);
  return done.status;
}

export async function publishedIn(workspace: string): Promise<string[]> {
  await setupWorkspace();
  const found = await rows<{ body: string }>(
    "SELECT body FROM briefings WHERE workspace = $1 AND status = 'published' ORDER BY id",
    [workspace],
  );
  return found.map((item) => item.body);
}

async function memoAnswer(person: string): Promise<AgentResult> {
  const workspace = "enterprise-stealth";
  const memo = await readMemo(person, workspace);
  if (memo === undefined) return refuse("You do not have access to that workspace.");
  return { route: "answer", text: memo, citations: [workspace] };
}

async function toneAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  const note = await recallTone(person, workspace);
  const text = `I have no tone saved for you in ${workspace}.`;
  if (note === undefined) return { route: "answer", text, citations: [workspace] };
  const said = `Using your tone in ${workspace}: ${note}`;
  return { route: "answer", text: said, citations: [workspace] };
}

async function publishAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  const id = await submitBriefing(person, workspace, "The Monday briefing");
  const text = `The briefing waits for an approver. Approval ${id} is waiting.`;
  return { route: "approve", text, citations: [workspace] };
}

async function ownApprovalAnswer(person: string): Promise<AgentResult> {
  await setupWorkspace();
  const waiting = await rows<{ id: number }>(
    "SELECT id FROM briefings WHERE writer = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [person],
  );
  if (waiting.length === 0) return refuse("You have no briefing waiting.");
  try {
    await approveBriefing(waiting[0].id, person);
  } catch (problem) {
    return refuse((problem as Error).message);
  }
  return { route: "answer", text: "The briefing is published.", citations: [] };
}

export async function answerWorkspace(
  question: string,
  person: string,
): Promise<AgentResult | undefined> {
  const text = question.toLowerCase();
  if (text.includes("memo")) return memoAnswer(person);
  if (text.includes("tone")) return toneAnswer(person);
  if (text.includes("approve my own")) return ownApprovalAnswer(person);
  if (text.includes("publish")) return publishAnswer(person);
  return undefined;
}
// #stub
//~ // TODO(tenancy-and-memory): wall the memo, scope the tone notes, let only an approver publish
//~ export async function isMember(_person: string, _workspace: string): Promise<boolean> {
//~   return true;
//~ }
//~
//~ export async function homeWorkspace(_person: string): Promise<string> {
//~   return "core-growth";
//~ }
//~
//~ export async function readMemo(_who: string, _space: string): Promise<string | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function rememberTone(
//~   _who: string,
//~   _space: string,
//~   _note: string,
//~ ): Promise<void> {}
//~
//~ export async function recallTone(_person: string, _space: string): Promise<string | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function submitBriefing(_writer: string, _space: string, _body: string) {
//~   return 0;
//~ }
//~
//~ export async function approveBriefing(_id: number, _approver: string): Promise<void> {}
//~
//~ export async function publishedIn(_workspace: string): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function answerWorkspace(
//~   _question: string,
//~   _person: string,
//~ ): Promise<AgentResult | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function applyWorkspaceWalls(): Promise<void> {}
//~
//~ export async function seedWorkspaces(): Promise<void> {}
//~
//~ export async function toneUnderWall(_person: string, _space: string): Promise<string[]> {
//~   return rows<{ note: string }>("SELECT note FROM tone_notes").then((all) =>
//~     all.map((item) => item.note),
//~   );
//~ }
//~
//~ export async function briefingsUnderWall(_person: string): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function postgresSaver(): Promise<PostgresSaver> {
//~   return PostgresSaver.fromConnString(DATABASE_URL);
//~ }
//~
//~ export type Brief = { writer: string; workspace: string; body: string };
//~
//~ export async function startBriefing(
//~   _saver: BaseCheckpointSaver,
//~   _thread: string,
//~   _brief: Brief,
//~ ): Promise<void> {}
//~
//~ export async function isWaiting(_saver: BaseCheckpointSaver, _id: string): Promise<boolean> {
//~   return false;
//~ }
//~
//~ export async function resumeBriefing(
//~   _saver: BaseCheckpointSaver,
//~   _thread: string,
//~   _decision: { approver: string; approved: boolean },
//~ ): Promise<string> {
//~   return "pending";
//~ }
// #endregion

// The teammates keep working when nobody asks. An event or the Monday clock adds one job.
// One key means one job. A crowd of events starts one run.
import { PgBoss } from "pg-boss";
import { MISSION_CONTROL_GOLDEN } from "../../../data/catalog/golden-mission-control";
import { DATABASE_URL, inTransaction, rows } from "../../../packages/core/src/db";
import { type GateResult, gate } from "../../../packages/core/src/gate";
import { claim, enqueue, type Job, resetJobs, runNext } from "../../../packages/core/src/jobs";
import { type AgentResult, type Grade, grade } from "../../../src/grade";
import { askMission } from "./mission";
import { resetSnapshots } from "./research";
import { siteWorld, startRivalSite } from "./rivals";
import {
  approveBriefing,
  homeWorkspace,
  resetWorkspace,
  setupWorkspace,
  submitBriefing,
} from "./workspace";

export const PRICE_EVENT = "competitor.changed";
export const BRIEFING_WRITER = "research-teammate";
const WINDOW_MS = 5 * 60 * 1000;
const WINDOW_SECONDS = 300;
const PRICE_RIVAL = "Pulsedesk";
const BURST_SIZE = 10;

export type Draft = { digest: string; post: string; channel: "linkedin" | "x" };
// The spec of the publish card.
export type ApprovalCard = {
  type: "ApprovalCard";
  props: { briefingId: number; title: string; digest: string; post: string; channel: string };
  actions: { id: "approve" | "reject"; label: string; needs: string }[];
};

type JobPayload = { kind: "research" | "briefing"; rival: string; workspace: string };

export async function setupAlwaysOn(): Promise<void> {
  await rows("CREATE TABLE IF NOT EXISTS runs (job_key text PRIMARY KEY, kind text, rival text)");
}

export async function resetAlwaysOn(): Promise<void> {
  await resetJobs();
  await rows("DROP TABLE IF EXISTS runs");
  await setupAlwaysOn();
}

function refuse(text: string): AgentResult {
  return { route: "refuse", text, citations: [] };
}

// #region lab:always-on-teammates
export function mondayOf(day: Date): string {
  const copy = new Date(day.getTime());
  const daysBack = (copy.getUTCDay() + 6) % 7;
  copy.setUTCDate(copy.getUTCDate() - daysBack);
  return copy.toISOString().slice(0, 10);
}

// The briefing agent. It drafts a digest for the team and one short post for LinkedIn or X.
// A person reads both on the approval card before anything goes out.
const POST_LIMIT = 280;
const SPLIT = "\n---\n";

export function writeBriefing(seen: string[], channel: Draft["channel"] = "x"): Draft {
  let digest = "Weekly briefing. No rival changed this week.";
  let post = "Quiet week on the rival front. We keep watching.";
  if (seen.length > 0) {
    digest = `Weekly briefing. Rival changes seen: ${seen.join(", ")}.`;
    post = `This week ${seen.join(" and ")} changed. We read the pages so you do not have to.`;
  }
  return { digest, post: post.slice(0, POST_LIMIT), channel };
}

export function packBody(draft: Draft): string {
  return [draft.digest, `${draft.channel}: ${draft.post}`].join(SPLIT);
}

export function unpackBody(body: string): Draft {
  const [digest, rest = ""] = body.split(SPLIT);
  const channel = rest.startsWith("linkedin:") ? "linkedin" : "x";
  return { digest, post: rest.slice(rest.indexOf(":") + 1).trim(), channel };
}

// The publish card. The web page draws the spec. The CLI prints the text of the same spec.
export function approvalCard(briefingId: number, body: string): ApprovalCard {
  const draft = unpackBody(body);
  return {
    type: "ApprovalCard",
    props: {
      briefingId,
      title: "Publish the Monday briefing",
      digest: draft.digest,
      post: draft.post,
      channel: draft.channel,
    },
    actions: [
      { id: "approve", label: "Approve and publish", needs: "approves briefings" },
      { id: "reject", label: "Reject", needs: "approves briefings" },
    ],
  };
}

export function cardText(card: ApprovalCard): string {
  const { title, digest, post, channel } = card.props;
  const choices = card.actions.map((action, place) => `${place + 1}. ${action.label}`);
  return [title, digest, `Post for ${channel}: ${post}`, ...choices].join("\n");
}

// The briefing that waits for a person. A job that ends here has paused the run.
export async function waitingCard(workspace: string): Promise<ApprovalCard | undefined> {
  const [waiting] = await rows<{ id: number; body: string }>(
    "SELECT id, body FROM briefings WHERE workspace = $1 AND status = 'pending' ORDER BY id",
    [workspace],
  );
  return waiting === undefined ? undefined : approvalCard(waiting.id, waiting.body);
}

function windowOf(moment: Date): number {
  return Math.floor(moment.getTime() / WINDOW_MS);
}

// The same two triggers on pg-boss, the queue that runs in production.
// The Monday clock is 09:00 UTC. One key per rival and window drops the crowd of events.
export const EVENT_QUEUE = "competitor-changed";
export const MONDAY_QUEUE = "monday-briefing";
export const MONDAY_CRON = "0 9 * * 1";
const BOSS_SCHEMA = "pgboss_always_on";

export async function startBoss(workspace: string): Promise<PgBoss> {
  const boss = new PgBoss({ connectionString: DATABASE_URL, schema: BOSS_SCHEMA });
  await boss.start();
  await boss.createQueue(EVENT_QUEUE);
  await boss.createQueue(MONDAY_QUEUE);
  await boss.schedule(MONDAY_QUEUE, MONDAY_CRON, { workspace }, { tz: "UTC" });
  return boss;
}

export async function stopBoss(boss: PgBoss): Promise<void> {
  await boss.stop({ graceful: false });
  await rows(`DROP SCHEMA IF EXISTS ${BOSS_SCHEMA} CASCADE`);
}

export async function sendEvent(boss: PgBoss, rival: string, moment: Date): Promise<boolean> {
  const bucket = windowOf(moment);
  const singletonKey = [PRICE_EVENT, rival, String(bucket)].join(":");
  const options = { singletonKey, singletonSeconds: WINDOW_SECONDS };
  return (await boss.send(EVENT_QUEUE, { rival }, options)) !== null;
}

// The golden gate. All 24 Mission Control cases run on recorded replies and a local rival site.
// A closed gate names the case that failed.
const CORE = "core-growth";
// The cases before the funnel questions read rival pages. The rest read none.
const RIVAL_CASES = MISSION_CONTROL_GOLDEN.cases.findIndex((item) => item.name === "funnel-drop");
const NO_PAGES = {
  fetchRival: async (): Promise<string> => {
    throw new Error("This case must not read a rival page.");
  },
};

// Puts the database in the state the case starts from.
async function prepare(name: string): Promise<void> {
  await resetWorkspace();
  await resetAlwaysOn();
  if (name === "monday-briefing" || name === "publish-approval") {
    await onEvent(PRICE_EVENT, PRICE_RIVAL, new Date());
    await drain();
  }
  if (name === "publish-approval") {
    await scheduleMonday(new Date(), CORE);
    await drain();
  }
  if (name === "writer-cannot-approve") await submitBriefing("priya", CORE, "Priya wrote this.");
  if (name === "crash-resume") {
    await scheduleMonday(new Date(), CORE);
    const job = await claim(-1);
    if (job !== undefined) await handleJob(job);
  }
}

async function gradeCase(index: number): Promise<Grade> {
  const found = MISSION_CONTROL_GOLDEN.cases[index];
  await prepare(found.name);
  if (index >= RIVAL_CASES) {
    return grade(found, await askMission(found.question, found.persona, NO_PAGES));
  }
  await resetSnapshots();
  const site = startRivalSite();
  try {
    const world = siteWorld(site.url);
    // The naive case asks about today's price, so the team sees only this week's page.
    if (found.kind !== "naive") {
      site.show("before");
      await askMission(found.question, found.persona, world);
    }
    site.show("after");
    return grade(found, await askMission(found.question, found.persona, world));
  } finally {
    site.stop();
  }
}

export async function goldenGate(): Promise<GateResult> {
  const grades: Grade[] = [];
  for (let index = 0; index < MISSION_CONTROL_GOLDEN.cases.length; index += 1) {
    grades.push(await gradeCase(index));
  }
  return gate(MISSION_CONTROL_GOLDEN, grades);
}

// Events of one kind, for one rival, in one five minute window share a key.
export async function onEvent(name: string, rival: string, moment: Date): Promise<boolean> {
  const bucket = windowOf(moment);
  const key = [name, rival, String(bucket)].join(":");
  const payload: JobPayload = { kind: "research", rival, workspace: "" };
  return enqueueJob(key, payload);
}

export async function scheduleMonday(day: Date, workspace: string): Promise<boolean> {
  const key = ["briefing", mondayOf(day)].join(":");
  const payload: JobPayload = { kind: "briefing", rival: "", workspace };
  return enqueueJob(key, payload);
}

async function enqueueJob(key: string, payload: JobPayload): Promise<boolean> {
  return enqueue(key, JSON.stringify(payload));
}

export async function rivalsSeen(): Promise<string[]> {
  await setupAlwaysOn();
  const found = await rows<{ rival: string }>(
    "SELECT DISTINCT rival FROM runs WHERE kind = 'research' ORDER BY rival",
  );
  return found.map((item) => item.rival);
}

async function recordRun(job: Job, payload: JobPayload): Promise<void> {
  await setupAlwaysOn();
  await rows("INSERT INTO runs VALUES ($1, 'research', $2) ON CONFLICT (job_key) DO NOTHING", [
    job.key,
    payload.rival,
  ]);
}

// The draft and the saved step land in one transaction, so a crash can never draft twice.
async function draftBriefing(
  job: Job,
  payload: JobPayload,
  afterDraft?: () => void,
): Promise<void> {
  if (job.step >= 1) return;
  await setupWorkspace();
  const seen = await rivalsSeen();
  const body = packBody(writeBriefing(seen));
  await inTransaction(async (run) => {
    const add = "INSERT INTO briefings (writer, workspace, body) VALUES ($1, $2, $3)";
    await run(add, [BRIEFING_WRITER, payload.workspace, body]);
    await run("UPDATE jobs SET step = 1 WHERE id = $1", [job.id]);
  });
  if (afterDraft !== undefined) afterDraft();
}

export async function handleJob(job: Job, afterDraft?: () => void): Promise<void> {
  const payload = JSON.parse(job.payload) as JobPayload;
  if (payload.kind === "research") return recordRun(job, payload);
  return draftBriefing(job, payload, afterDraft);
}

// Runs each job that is ready. A job left by a dead worker counts too.
export async function drain(): Promise<number> {
  let count = 0;
  while (await runNext((job) => handleJob(job))) count += 1;
  return count;
}

async function eventAnswer(): Promise<AgentResult> {
  await onEvent(PRICE_EVENT, PRICE_RIVAL, new Date());
  const count = await drain();
  const text = `The research run finished for ${PRICE_RIVAL}. Runs started: ${count}.`;
  return { route: "answer", text, citations: [PRICE_EVENT] };
}

async function burstAnswer(): Promise<AgentResult> {
  const arrived = new Date();
  for (let sent = 0; sent < BURST_SIZE; sent += 1) {
    await onEvent(PRICE_EVENT, PRICE_RIVAL, arrived);
  }
  const count = await drain();
  const text = `${BURST_SIZE} events arrived. Runs started: ${count}.`;
  return { route: "answer", text, citations: [PRICE_EVENT] };
}

async function mondayAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  await scheduleMonday(new Date(), workspace);
  await drain();
  const text = "The weekly briefing is drafted. It waits for an approver.";
  return { route: "answer", text, citations: [workspace] };
}

async function resumeAnswer(): Promise<AgentResult> {
  const count = await drain();
  const text = `Stopped jobs picked up and finished: ${count}.`;
  return { route: "answer", text, citations: [] };
}

async function approveAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  const waiting = await rows<{ id: number }>(
    "SELECT id FROM briefings WHERE workspace = $1 AND status = 'pending' ORDER BY id LIMIT 1",
    [workspace],
  );
  if (waiting.length === 0) return refuse("No briefing is waiting.");
  try {
    await approveBriefing(waiting[0].id, person);
  } catch (problem) {
    return refuse((problem as Error).message);
  }
  return { route: "approve", text: "The briefing is published to the team.", citations: [] };
}

export async function answerAlwaysOn(
  question: string,
  person: string,
): Promise<AgentResult | undefined> {
  const text = question.toLowerCase();
  if (text.includes("research run")) return eventAnswer();
  if (text.includes("price events")) return burstAnswer();
  if (text.includes("monday") && text.includes("draft")) return mondayAnswer(person);
  if (text.includes("stops halfway")) return resumeAnswer();
  if (text.includes("approve the") && text.includes("briefing")) return approveAnswer(person);
  return undefined;
}
// #stub
//~ // TODO(always-on-teammates): turn events and the Monday clock into one job each
//~ export function mondayOf(_day: Date): string {
//~   return "";
//~ }
//~
//~ export async function onEvent(_name: string, _rival: string, _moment: Date): Promise<boolean> {
//~   return false;
//~ }
//~
//~ export async function scheduleMonday(_day: Date, _workspace: string): Promise<boolean> {
//~   return false;
//~ }
//~
//~ export async function rivalsSeen(): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function handleJob(_job: Job, _afterDraft?: () => void): Promise<void> {}
//~
//~ export async function drain(): Promise<number> {
//~   return 0;
//~ }
//~
//~ export async function answerAlwaysOn(
//~   _question: string,
//~   _person: string,
//~ ): Promise<AgentResult | undefined> {
//~   return undefined;
//~ }
//~
//~ export function writeBriefing(_seen: string[], _channel: Draft["channel"] = "x"): Draft {
//~   return { digest: "", post: "", channel: "x" };
//~ }
//~
//~ export function approvalCard(_briefingId: number, _body: string): ApprovalCard {
//~   return { type: "ApprovalCard", props: { briefingId: 0, title: "", digest: "", post: "", channel: "" }, actions: [] };
//~ }
//~
//~ export function cardText(_card: ApprovalCard): string {
//~   return "";
//~ }
//~
//~ export async function waitingCard(_workspace: string): Promise<ApprovalCard | undefined> {
//~   return undefined;
//~ }
//~
//~ export const EVENT_QUEUE = "";
//~ export const MONDAY_QUEUE = "";
//~ export const MONDAY_CRON = "";
//~
//~ export async function startBoss(_workspace: string): Promise<PgBoss> {
//~   throw new Error("TODO(always-on-teammates): start pg-boss and save the Monday schedule");
//~ }
//~
//~ export async function stopBoss(_boss: PgBoss): Promise<void> {}
//~
//~ export async function sendEvent(_boss: PgBoss, _rival: string, _moment: Date): Promise<boolean> {
//~   return false;
//~ }
//~
//~ export async function goldenGate(): Promise<GateResult> {
//~   return { open: true, passed: 0, total: 0, failures: [] };
//~ }
// #endregion

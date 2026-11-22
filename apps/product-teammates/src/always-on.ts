// The teammates keep working when nobody asks. An event or the Monday clock adds one job.
// One key means one job. A crowd of events starts one run.
import { inTransaction, rows } from "../../../packages/core/src/db";
import { enqueue, type Job, resetJobs, runNext } from "../../../packages/core/src/jobs";
import type { AgentResult } from "../../../src/grade";
import { approveBriefing, homeWorkspace, setupWorkspace } from "./workspace";

export const PRICE_EVENT = "competitor.changed";
export const BRIEFING_WRITER = "research-teammate";
const WINDOW_MS = 5 * 60 * 1000;
const PRICE_RIVAL = "Pulsedesk";
const BURST_SIZE = 10;

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

// Events of one kind, for one rival, in one five minute window share a key.
export async function onEvent(name: string, rival: string, moment: Date): Promise<boolean> {
  const bucket = Math.floor(moment.getTime() / WINDOW_MS);
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
  let body = "Weekly briefing. No rival changed this week.";
  if (seen.length > 0) body = `Weekly briefing. Rival changes seen: ${seen.join(", ")}.`;
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
// #endregion

/**
 * Write the open-coding notes and pass/fail marks for the error-analysis seed.
 *
 * Finds the root observations tagged error-analysis-seed, adds any that are
 * missing from the "error analysis" queue, and writes two annotation scores
 * on each: open coding (text) and pass or fail. Those items are then marked
 * completed. Other items already in the queue are left alone.
 *
 * The notes come from scripts/error-analysis-traffic.ts. Each one was written by
 * reading the recorded answer, and none of them names a failure mode, so the
 * learner still has to find the patterns.
 *
 * Idempotent. Each score uses a stable id, so a second run updates the same
 * scores instead of adding another pair. The score time is the time of the
 * run, so the notes stay inside the time range the Langfuse screens use.
 *
 *   npm run langfuse:seed:error-analysis:annotations
 *   npm run langfuse:seed:error-analysis:annotations -- --dry-run
 *   npx tsx scripts/seed-error-analysis-annotations.ts --check
 */
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/server/env";
import { TRAFFIC, type TrafficTurn } from "./error-analysis-traffic";
import { runMain } from "./run-main";

const SEED_TAG = "error-analysis-seed";
const DEFAULT_QUEUE_NAME = "error analysis";
const OPEN_CODING_NAME = "open coding";
const PASS_FAIL_NAME = "pass or fail";
// The failure modes lesson 04 asks the learner to name. A note that names one gives the answer away.
const MODE_WORDS = /over-ask|off-label|wrong country|country leak|future label|failure mode/i;

type QueueItem = {
  id: string;
  objectId: string;
  objectType: string;
  status: string;
};

type ScoreConfig = {
  id: string;
  name: string;
  dataType: string;
  categories?: Array<{ label: string }> | null;
};

type RootObservation = {
  id: string;
  traceId: string;
  startTime: string;
  environment?: string;
  input: unknown;
  output: unknown;
};

const hasFlag = (flag: string) => process.argv.includes(flag);
function readStringFlag(flag: string) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

export function assertAnnotationTemplates() {
  if (new Set(TRAFFIC.map((turn) => turn.question)).size !== TRAFFIC.length) {
    throw new Error("Two error-analysis turns ask the same question, so their notes cannot be told apart.");
  }
  for (const turn of TRAFFIC) {
    if (turn.note.length < 1 || turn.note.length > 500) throw new Error(`Note for ${turn.id} has length ${turn.note.length}.`);
    if (MODE_WORDS.test(turn.note)) throw new Error(`Note for ${turn.id} names a failure mode: ${turn.note}`);
  }
}

// The last question the doctor asked, from the root observation input.
function lastQuestion(input: unknown) {
  let parsed = parseJson(input);
  if (Array.isArray(parsed)) parsed = parsed[0];
  const messages = (parsed as { messages?: Array<{ type?: string; role?: string; content?: unknown }> } | null)?.messages ?? [];
  const asked = messages.filter((message) => (message.type === "human" || message.role === "user") && typeof message.content === "string");
  return String(asked.at(-1)?.content ?? "").trim();
}

function parseJson(value: unknown) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function scoreId(observationId: string, name: string) {
  const hash = createHash("sha256").update(`error-analysis:${observationId}:${name}`).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
}

function requireCredentials() {
  if (!env.langfusePublicKey || !env.langfuseSecretKey) {
    throw new Error("Langfuse credentials are required to seed annotations.");
  }
}

async function api(method: string, pathname: string, body?: unknown, query?: Record<string, string>) {
  const url = new URL(pathname, env.langfuseBaseUrl);
  for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64")}`,
      "Content-Type": "application/json"
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text ? (JSON.parse(text) as unknown) : null;
  if (response.status === 207) {
    throw new Error(`${method} ${pathname} partially rejected scores: ${text.slice(0, 800)}`);
  }
  if (!response.ok) {
    throw new Error(`${method} ${pathname} failed (${response.status}): ${text.slice(0, 800)}`);
  }
  return parsed;
}

async function listPages<T>(pathname: string, query: Record<string, string> = {}) {
  const rows: T[] = [];
  let page = 1;
  for (;;) {
    const body = (await api("GET", pathname, undefined, { ...query, page: String(page), limit: "100" })) as {
      data: T[];
      meta?: { totalPages?: number };
    };
    rows.push(...body.data);
    if (!body.meta?.totalPages || page >= body.meta.totalPages) return rows;
    page += 1;
  }
}

async function listObservations() {
  const rows: RootObservation[] = [];
  let cursor: string | undefined;
  const filter = JSON.stringify([
    { type: "arrayOptions", column: "traceTags", operator: "any of", value: [SEED_TAG] },
    { type: "string", column: "name", operator: "=", value: "hcp-medinfo-chat-turn" },
    { type: "boolean", column: "isRootObservation", operator: "=", value: true }
  ]);
  for (;;) {
    const query: Record<string, string> = {
      fields: "core,basic,io",
      fromStartTime: "2020-01-01T00:00:00.000Z",
      limit: "100",
      filter
    };
    if (cursor) query.cursor = cursor;
    const body = (await api("GET", "/api/public/v2/observations", undefined, query)) as {
      data: RootObservation[];
      meta?: { cursor?: string | null };
    };
    rows.push(...body.data);
    if (!body.meta?.cursor) return rows;
    cursor = body.meta.cursor;
  }
}

function queueConfigs(configs: ScoreConfig[]) {
  const openCoding = configs.find((config) => config.dataType === "TEXT" && config.name === OPEN_CODING_NAME);
  const passFail = configs.find((config) => {
    const labels = (config.categories ?? []).map((category) => category.label.toLowerCase());
    return config.dataType === "CATEGORICAL" && config.name === PASS_FAIL_NAME && labels.includes("pass") && labels.includes("fail");
  });
  if (!openCoding || !passFail) {
    throw new Error(`Queue needs a text config "${OPEN_CODING_NAME}" and a categorical config "${PASS_FAIL_NAME}" with pass and fail.`);
  }
  return { openCoding, passFail };
}

async function main() {
  if (hasFlag("--check")) {
    assertAnnotationTemplates();
    const passes = TRAFFIC.filter((turn) => turn.pass).length;
    console.log(`Error-analysis annotations OK: ${TRAFFIC.length} notes, ${passes} pass and ${TRAFFIC.length - passes} fail.`);
    return;
  }

  requireCredentials();
  const queueName = readStringFlag("--queue") ?? DEFAULT_QUEUE_NAME;
  const dryRun = hasFlag("--dry-run");
  const byQuestion = new Map<string, TrafficTurn>(TRAFFIC.map((turn) => [turn.question, turn]));

  const queues = await listPages<{ id: string; name: string; scoreConfigIds: string[] }>("/api/public/annotation-queues");
  const queue = queues.find((entry) => entry.name === queueName);
  if (!queue) {
    throw new Error(`No annotation queue named "${queueName}". Found: ${queues.map((entry) => entry.name).join(", ") || "none"}.`);
  }
  const configs = await Promise.all(
    queue.scoreConfigIds.map((configId) => api("GET", `/api/public/score-configs/${configId}`) as Promise<ScoreConfig>)
  );
  const { openCoding, passFail } = queueConfigs(configs);
  const observations = await listObservations();
  if (observations.length === 0) {
    throw new Error(`No root observations tagged ${SEED_TAG}. Run npm run langfuse:seed:error-analysis first.`);
  }

  const planned = observations.map((observation) => {
    const ask = lastQuestion(observation.input);
    const turn = byQuestion.get(ask);
    if (!turn) {
      throw new Error(`Observation ${observation.id} does not match an error-analysis turn. Last question: ${ask.slice(0, 80)}`);
    }
    return { observation, annotation: { passFail: turn.pass ? ("pass" as const) : ("fail" as const), note: turn.note } };
  });

  const counts = { pass: 0, fail: 0 };
  for (const entry of planned) counts[entry.annotation.passFail] += 1;
  console.log(
    `${dryRun ? "Would annotate" : "Annotating"} ${planned.length} observations on "${queue.name}": ${counts.pass} pass, ${counts.fail} fail.`
  );
  if (dryRun) {
    for (const entry of planned) {
      console.log(`- ${entry.annotation.passFail}: ${entry.annotation.note}`);
    }
    return;
  }

  const items = await listPages<QueueItem>(`/api/public/annotation-queues/${queue.id}/items`);
  const itemsByObject = new Map(items.filter((item) => item.objectType === "OBSERVATION").map((item) => [item.objectId, item]));

  const scores: Array<Record<string, unknown>> = [];
  for (const entry of planned) {
    let item = itemsByObject.get(entry.observation.id);
    if (!item) {
      item = (await api("POST", `/api/public/annotation-queues/${queue.id}/items`, {
        objectId: entry.observation.id,
        objectType: "OBSERVATION",
        status: "PENDING"
      })) as QueueItem;
      itemsByObject.set(entry.observation.id, item);
    }
    const shared = {
      traceId: entry.observation.traceId,
      observationId: entry.observation.id,
      queueId: queue.id,
      source: "ANNOTATION",
      timestamp: new Date().toISOString(),
      environment: entry.observation.environment
    };
    scores.push({
      ...shared,
      id: scoreId(entry.observation.id, openCoding.name),
      name: openCoding.name,
      configId: openCoding.id,
      dataType: "TEXT",
      value: entry.annotation.note
    });
    scores.push({
      ...shared,
      id: scoreId(entry.observation.id, passFail.name),
      name: passFail.name,
      configId: passFail.id,
      dataType: "CATEGORICAL",
      value: entry.annotation.passFail
    });
  }

  for (let index = 0; index < scores.length; index += 20) {
    await api("POST", "/api/public/scores", scores.slice(index, index + 20));
  }

  let completed = 0;
  for (const entry of planned) {
    const item = itemsByObject.get(entry.observation.id);
    if (!item) throw new Error(`Queue item missing for observation ${entry.observation.id}.`);
    if (item.status !== "COMPLETED") {
      await api("PATCH", `/api/public/annotation-queues/${queue.id}/items/${item.id}`, { status: "COMPLETED" });
      completed += 1;
    }
  }

  console.log(`Wrote ${scores.length} scores and completed ${completed} queue items.`);
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) void runMain(main, { name: "Error analysis annotations seed" });

/**
 * Seed the answers lesson 09 calibrates the faithfulness judge on.
 *
 * data/calibration/faithfulness-set.json holds them. Eleven are the agent's own answers from the
 * 06, 07 and 09 runs. Every stored answer we read was faithful, so ten are copies with one
 * edit each (a wrong dose, a claim no source makes, a wrong citation), and the file says what
 * changed. A judge you can only test on faithful answers cannot show you its kappa.
 * The last one, real-review-process-note, is the answer the calibrated judge got wrong in the
 * 09 run: a kind of answer the first 20 did not hold, added before the rubric was changed.
 *
 * Each answer becomes one trace with one generation, the same shape as the agent's final
 * generation: input {"messages": [...]} with the tool results, output the answer. So the
 * evaluator mapping you build on these works on live traffic unchanged.
 *
 * It creates the BOOLEAN score config "faithfulness" and the queue "faithfulness calibration"
 * when they are missing, and adds every generation to the queue. You label them by hand.
 * --labels also writes our labels as ANNOTATION scores (the answer key, for maintainers).
 *
 *   npm run langfuse:seed:calibration
 *   npm run langfuse:seed:calibration -- --labels
 *   npm run langfuse:seed:calibration -- --check     (no network: the file is well formed)
 *
 * Safe to run again: answers already in Langfuse are found by tag and reused, and only the
 * answers added to the file since are seeded.
 */
import "../src/server/load-env";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation } from "@langfuse/tracing";
import { env } from "../src/server/env";
import { SCORE_NAME } from "./judge/faithfulness";

export const CALIBRATION_TAG = "faithfulness-calibration";
export const QUEUE_NAME = "faithfulness calibration";
export const SET_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/calibration/faithfulness-set.json");

type Message = { role: string; content?: string | null; tool_calls?: unknown };
export type SetItem = { id: string; basedOn: string; label: boolean; edit: string | null; messages: Message[]; answer: string };

export function readSet(file = SET_FILE): SetItem[] {
  return (JSON.parse(readFileSync(file, "utf8")) as { items: SetItem[] }).items;
}

// 20 or more answers, both labels well represented, every unfaithful one says what was changed,
// and every answer has tool results to be judged against.
export function setProblems(items: SetItem[]): string[] {
  const problems: string[] = [];
  if (items.length < 20) problems.push(`The calibration set has ${items.length} answers; it needs 20.`);
  const unfaithful = items.filter((item) => !item.label).length;
  if (unfaithful < 6 || items.length - unfaithful < 6) problems.push(`Each label needs 6 or more answers; ${unfaithful} are unfaithful.`);
  if (new Set(items.map((item) => item.id)).size !== items.length) problems.push("Two answers share an id.");
  for (const item of items) {
    if (!item.messages.some((message) => message.role === "tool")) problems.push(`${item.id} has no tool results.`);
    if (!item.label && !item.edit) problems.push(`${item.id} is unfaithful but does not say what was changed.`);
  }
  return problems;
}

const auth = () => `Basic ${Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64")}`;

async function api<T>(method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${env.langfuseBaseUrl}${route}`, {
    method,
    headers: { Authorization: auth(), "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000)
  });
  const text = await response.text();
  if (!response.ok || response.status === 207) throw new Error(`${method} ${route} failed (${response.status}): ${text.slice(0, 400)}`);
  return (text ? JSON.parse(text) : null) as T;
}

async function allPages<T>(route: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const body = await api<{ data: T[]; meta: { totalPages: number } }>("GET", `${route}${route.includes("?") ? "&" : "?"}limit=100&page=${page}`);
    rows.push(...body.data);
    if (page >= body.meta.totalPages) return rows;
  }
}

async function ensureQueue() {
  const configs = await allPages<{ id: string; name: string; dataType: string; isArchived?: boolean }>("/api/public/score-configs");
  const config =
    configs.find((row) => row.name === SCORE_NAME && row.dataType === "BOOLEAN" && !row.isArchived) ??
    (await api<{ id: string }>("POST", "/api/public/score-configs", {
      name: SCORE_NAME,
      dataType: "BOOLEAN",
      description: "Every claim in the answer is supported by the tool results the agent read."
    }));
  const queues = await allPages<{ id: string; name: string }>("/api/public/annotation-queues");
  const queue =
    queues.find((row) => row.name === QUEUE_NAME) ??
    (await api<{ id: string }>("POST", "/api/public/annotation-queues", {
      name: QUEUE_NAME,
      description: "Lesson 09: label each answer faithful or not against its tool results.",
      scoreConfigIds: [config.id]
    }));
  return { configId: config.id, queueId: queue.id };
}

function seedTraces(items: SetItem[]) {
  const start = Date.now() - 30 * 60_000;
  items.forEach((item, index) => {
    const at = new Date(start + index * 60_000);
    // The live agent puts the trace name, tags and session on every span, so a filter on a
    // generation can use them. The seed does the same.
    const traceAttributes = {
      "langfuse.trace.name": "hcp-medinfo-chat-turn",
      "langfuse.trace.tags": [CALIBRATION_TAG],
      "session.id": `calibration-${item.id}`
    };
    const root = startObservation("hcp-medinfo-chat-turn", {}, { startTime: at });
    root.otelSpan.setAttributes({
      ...traceAttributes,
      "langfuse.observation.input": JSON.stringify(item.messages.find((message) => message.role === "user")?.content ?? ""),
      "langfuse.observation.output": JSON.stringify(item.answer)
    });
    const generation = startObservation("OpenAI.chat", {}, { startTime: at, parentSpanContext: root.otelSpan.spanContext() });
    generation.otelSpan.setAttributes({
      ...traceAttributes,
      "langfuse.observation.type": "generation",
      "langfuse.observation.model.name": env.openaiModel,
      "langfuse.observation.input": JSON.stringify({ messages: item.messages }),
      "langfuse.observation.output": JSON.stringify(item.answer)
    });
    generation.otelSpan.end(new Date(at.getTime() + 2_000));
    root.otelSpan.end(new Date(at.getTime() + 2_000));
  });
}

type Seeded = { item: SetItem; traceId: string; observationId: string };

const observationsWhere = (filter: unknown[]) =>
  api<{ data: { id: string; traceId: string; type: string; sessionId?: string }[] }>(
    "GET",
    `/api/public/v2/observations?fields=core,basic&limit=100&fromStartTime=2020-01-01T00:00:00.000Z&filter=${encodeURIComponent(JSON.stringify(filter))}`
  );

// The seeded answers already in Langfuse: the generation tagged with the calibration tag,
// matched to the set by its session id.
async function findSeeded(items: SetItem[]): Promise<Seeded[]> {
  const rows = (
    await observationsWhere([
      { type: "arrayOptions", column: "traceTags", operator: "any of", value: [CALIBRATION_TAG] },
      { type: "string", column: "type", operator: "=", value: "GENERATION" }
    ])
  ).data;
  return items.flatMap((item) => {
    const row = rows.find((entry) => entry.sessionId === `calibration-${item.id}`);
    return row ? [{ item, traceId: row.traceId, observationId: row.id }] : [];
  });
}

// Ingestion is asynchronous: wait until every seeded generation can be read back.
async function waitForSeeded(items: SetItem[]) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const seeded = await findSeeded(items);
    if (seeded.length === items.length) return seeded;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error("The seeded answers did not appear in Langfuse within 60 seconds.");
}

async function main() {
  const items = readSet();
  const problems = setProblems(items);
  if (problems.length) throw new Error(problems.join("\n"));
  const unfaithful = items.filter((item) => !item.label).length;
  if (process.argv.includes("--check")) {
    console.log(`Calibration set OK: ${items.length} answers, ${items.length - unfaithful} faithful and ${unfaithful} not.`);
    return;
  }
  if (!env.langfusePublicKey || !env.langfuseSecretKey) throw new Error("Langfuse credentials are required.");

  const { configId, queueId } = await ensureQueue();
  let seeded = await findSeeded(items);
  const missing = items.filter((item) => !seeded.some((row) => row.item.id === item.id));
  if (missing.length) {
    const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
    sdk.start();
    seedTraces(missing);
    await sdk.shutdown();
    seeded = await waitForSeeded(items);
    console.log(`Seeded ${missing.length} answers tagged ${CALIBRATION_TAG}.`);
  } else {
    console.log(`The ${seeded.length} answers are already in Langfuse; nothing seeded.`);
  }

  const queued = new Set(
    (await allPages<{ objectId: string }>(`/api/public/annotation-queues/${queueId}/items`)).map((row) => row.objectId)
  );
  for (const row of seeded.filter((entry) => !queued.has(entry.observationId))) {
    await api("POST", `/api/public/annotation-queues/${queueId}/items`, { objectId: row.observationId, objectType: "OBSERVATION", status: "PENDING" });
  }
  console.log(`${seeded.length} answers on the queue "${QUEUE_NAME}".`);

  if (process.argv.includes("--labels")) {
    // A fixed id per answer, so a second run replaces the label instead of adding one.
    const scores = seeded.map((row) => ({
      id: `calibration-label-${row.observationId}`,
      traceId: row.traceId,
      observationId: row.observationId,
      queueId,
      name: SCORE_NAME,
      configId,
      dataType: "BOOLEAN",
      value: row.item.label ? 1 : 0,
      source: "ANNOTATION",
      comment: row.item.edit ?? "The agent's own answer, unchanged."
    }));
    for (const score of scores) await api("POST", "/api/public/scores", score);
    console.log(`Wrote ${scores.length} labels: ${items.length - unfaithful} faithful, ${unfaithful} unfaithful.`);
  }
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

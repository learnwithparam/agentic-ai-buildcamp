/**
 * Seed the traffic for lesson 04 error analysis.
 *
 * Replays the 20 recorded turns in data/error-analysis-traffic.json into Langfuse.
 * Each turn is a real answer from the agent, recorded by scripts/record-error-analysis.ts
 * with every span it emitted, so a seeded trace has the same tree, prompt link, token
 * usage and cost as a live one. Only the times, the session and the user change, and
 * each trace gets the error-analysis-seed tag.
 *
 * Not idempotent: every run creates 20 new traces.
 *
 *   npm run langfuse:seed:error-analysis
 *   npm run langfuse:seed:error-analysis -- --check
 */
import "../src/server/load-env";
import { readFileSync } from "node:fs";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { startObservation, type LangfuseObservation } from "@langfuse/tracing";
import { TRAFFIC } from "./error-analysis-traffic";
import { TRAFFIC_FILE, type RecordedSpan, type RecordedTurn } from "./error-analysis-replay";
import { runMain } from "./run-main";

export const SEED_TAG = "error-analysis-seed";
const ROOT_NAME = "hcp-medinfo-chat-turn";

export function readTraffic(): RecordedTurn[] {
  return JSON.parse(readFileSync(TRAFFIC_FILE, "utf8")) as RecordedTurn[];
}

// Every question in error-analysis-traffic.ts has one recorded turn, with one root span.
export function checkTraffic(recorded: RecordedTurn[]) {
  const ids = TRAFFIC.map((turn) => turn.id);
  if (JSON.stringify(recorded.map((turn) => turn.id)) !== JSON.stringify(ids)) {
    throw new Error(`Recorded turns do not match the questions. Run npx tsx scripts/record-error-analysis.ts.`);
  }
  for (const turn of recorded) {
    const roots = turn.spans.filter((span) => span.parentId === null);
    if (roots.length !== 1 || roots[0].name !== ROOT_NAME) throw new Error(`Turn ${turn.id} needs one ${ROOT_NAME} root.`);
    const question = TRAFFIC.find((entry) => entry.id === turn.id)?.question ?? "";
    if (!String(roots[0].attributes["langfuse.observation.input"]).includes(JSON.stringify(question).slice(1, -1))) {
      throw new Error(`Turn ${turn.id} was recorded for another question.`);
    }
  }
}

// A parent and its first child can start in the same millisecond, so order by depth, not by time.
export function parentFirst(spans: RecordedSpan[]) {
  const byId = new Map(spans.map((span) => [span.id, span]));
  const depth = (span: RecordedSpan): number => (span.parentId && byId.has(span.parentId) ? 1 + depth(byId.get(span.parentId)!) : 0);
  return [...spans].sort((a, b) => depth(a) - depth(b) || a.startMs - b.startMs);
}

function replayTurn(turn: RecordedTurn, startedAt: number) {
  const user = TRAFFIC.find((entry) => entry.id === turn.id)?.user ?? "seed-user";
  const created = new Map<string, LangfuseObservation>();
  for (const span of parentFirst(turn.spans)) {
    const parent = span.parentId ? created.get(span.parentId) : undefined;
    if (span.parentId && !parent) throw new Error(`Turn ${turn.id}: span ${span.name} has no recorded parent.`);
    const observation = startObservation(
      span.name,
      {},
      { startTime: new Date(startedAt + span.startMs), parentSpanContext: parent?.otelSpan.spanContext() }
    );
    const attributes = { ...span.attributes } as Record<string, string | number | boolean | string[]>;
    if (!span.parentId) {
      attributes["session.id"] = `ea-${turn.id}`;
      attributes["user.id"] = user;
      attributes["langfuse.trace.tags"] = [...((attributes["langfuse.trace.tags"] as string[]) ?? []), SEED_TAG];
    }
    observation.otelSpan.setAttributes(attributes);
    created.set(span.id, observation);
  }
  for (const span of turn.spans) created.get(span.id)?.otelSpan.end(new Date(startedAt + span.endMs));
}

async function main() {
  const recorded = readTraffic();
  checkTraffic(recorded);
  if (process.argv.includes("--check")) {
    console.log(`Error-analysis traffic OK: ${recorded.length} recorded turns.`);
    return;
  }
  const sdk = new NodeSDK({ spanProcessors: [new LangfuseSpanProcessor()] });
  sdk.start();
  // The newest turn ends 10 minutes ago, and turns are 90 seconds apart.
  const firstStart = Date.now() - 10 * 60_000 - recorded.length * 90_000;
  recorded.forEach((turn, index) => replayTurn(turn, firstStart + index * 90_000));
  await sdk.shutdown();
  console.log(`Seeded ${recorded.length} traces tagged ${SEED_TAG}.`);
}

if (process.argv[1]?.endsWith("seed-error-analysis-traces.ts")) void runMain(main, { name: "Error analysis seed" });

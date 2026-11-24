/**
 * Record the error-analysis traffic: ask every question in scripts/error-analysis-traffic.ts
 * of the real agent, and save each turn's spans to data/error-analysis-traffic.json.
 *
 * Spans go to memory, not to Langfuse, so recording leaves no traces behind.
 * npm run langfuse:seed:error-analysis replays the file into Langfuse.
 *
 * Maintainers run this when the agent or the questions change. It calls the model.
 *
 *   npx tsx scripts/record-error-analysis.ts
 *   npx tsx scripts/record-error-analysis.ts --only de-renal   # record one turn again, keep the rest
 */
import "../src/server/load-env";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { answerConversation } from "../src/server/medinfo-agent";
import { TRAFFIC } from "./error-analysis-traffic";
import { TRAFFIC_FILE, type RecordedSpan, type RecordedTurn } from "./error-analysis-replay";

const exporter = new tracing.InMemorySpanExporter();
const sdk = new NodeSDK({ spanProcessors: [new tracing.SimpleSpanProcessor(exporter)] });
sdk.start();

const toMs = ([seconds, nanos]: [number, number]) => seconds * 1000 + nanos / 1e6;

const onlyIndex = process.argv.indexOf("--only");
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const kept = new Map<string, RecordedTurn>(
  only && existsSync(TRAFFIC_FILE) ? (JSON.parse(readFileSync(TRAFFIC_FILE, "utf8")) as RecordedTurn[]).map((turn) => [turn.id, turn]) : []
);

const turns: RecordedTurn[] = [];
for (const turn of TRAFFIC) {
  const previous = kept.get(turn.id);
  if (only && turn.id !== only && previous) {
    turns.push(previous);
    continue;
  }
  exporter.reset();
  const answer = await answerConversation([...(turn.history ?? []), { role: "user", content: turn.question }]);
  const spans = exporter.getFinishedSpans();
  const start = Math.min(...spans.map((span) => toMs(span.startTime)));
  const recorded: RecordedSpan[] = spans.map((span) => ({
    id: span.spanContext().spanId,
    parentId: span.parentSpanContext?.spanId ?? null,
    name: span.name,
    startMs: toMs(span.startTime) - start,
    endMs: toMs(span.endTime) - start,
    attributes: span.attributes
  }));
  turns.push({ id: turn.id, answer, spans: recorded });
  console.log(`${turn.id}: ${recorded.length} spans\n${answer}\n`);
}

writeFileSync(TRAFFIC_FILE, `${JSON.stringify(turns, null, 1)}\n`);
console.log(`Saved ${turns.length} turns to ${TRAFFIC_FILE}.`);
await sdk.shutdown();

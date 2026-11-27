import type { TurnMetrics } from "./meter";

// The three numbers docs/measures.md asks of operations, from a list of measured turns.
export type OpsMeasures = {
  p95_latency_seconds: number;
  cost_per_question_usd: number;
  parse_failure_rate: number;
};

// Nearest rank: the smallest value that at least p of the values are at or below.
export function percentile(values: number[], p: number): number {
  if (!values.length) throw new Error("A percentile needs at least one value.");
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(1, Math.ceil(p * sorted.length)) - 1]!;
}

const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;

export function summarize(turns: TurnMetrics[]): OpsMeasures {
  if (!turns.length) throw new Error("There are no turns to summarize.");
  const structured = turns.reduce((sum, turn) => sum + turn.structuredCalls, 0);
  return {
    p95_latency_seconds: round(percentile(turns.map((turn) => turn.seconds), 0.95), 2),
    cost_per_question_usd: round(turns.reduce((sum, turn) => sum + turn.costUsd, 0) / turns.length, 5),
    // Per structured call, not per turn: a turn with three such calls and one bad one is 1 of 3.
    parse_failure_rate: structured ? round(turns.reduce((sum, turn) => sum + turn.parseFailures, 0) / structured, 4) : 0
  };
}

type ScoreClient = {
  score: {
    create: (score: { traceId: string; name: string; value: number; dataType: "NUMERIC" }) => void;
    flush: () => Promise<void>;
  };
};

// The same numbers, one turn at a time, as Langfuse scores on the turn's trace. Sent in the
// background: the doctor's answer never waits on Langfuse.
export function scoreTurn(langfuse: ScoreClient, traceId: string | undefined, metrics: TurnMetrics) {
  if (!traceId) return;
  const score = (name: string, value: number) => langfuse.score.create({ traceId, name, value, dataType: "NUMERIC" });
  score("latency_seconds", round(metrics.seconds, 2));
  // A turn with a call that reported no cost has no honest total, so it gets none.
  if (metrics.callsWithoutCost === 0) score("cost_usd", round(metrics.costUsd, 6));
  score("parse_failures", metrics.parseFailures);
  void langfuse.score.flush().catch((error: Error) => console.warn(`The turn scores were not sent: ${error.message}`));
}

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { percentile, summarize } from "../src/server/ops/metrics";
import { fixedTurns, measure, toRun } from "./ops-eval";

// The arithmetic of npm run ops:measure, offline: no model call, no database.

test("the 95th percentile is the nearest rank", () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 0.95), 5);
  assert.equal(percentile(Array.from({ length: 20 }, (_, i) => i + 1), 0.95), 19);
  assert.equal(percentile(Array.from({ length: 21 }, (_, i) => i + 1), 0.95), 20);
  assert.equal(percentile([7], 0.95), 7);
  assert.throws(() => percentile([], 0.95));
});

test("the summary averages cost per question and counts failures per structured call", () => {
  assert.deepEqual(summarize(fixedTurns()), { p95_latency_seconds: 19, cost_per_question_usd: 0.04, parse_failure_rate: 0.025 });
});

test("a call with no cost stops the run instead of lowering the average", () => {
  const turns = fixedTurns();
  turns[0] = { ...turns[0]!, callsWithoutCost: 1 };
  assert.throws(() => toRun(turns, { commit: "x", at: "y", fake: true }), /no cost/);
});

test("--fake writes the run file shape from fixed turns", async () => {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "ops-")), "ops.json");
  const run = await measure({ fake: true, out });
  assert.deepEqual(JSON.parse(readFileSync(out, "utf8")), run);
  assert.deepEqual(run.measures, { "ops.p95_latency_seconds": 19, "ops.cost_per_question_usd": 0.04, "ops.parse_failure_rate": 0.025 });
  assert.equal(run.fake, true);
  assert.equal(run.questions, 20);
});

test("a turn with no model call stops the run: a desk answer always calls the model", () => {
  const turns = fixedTurns();
  turns[2] = { ...turns[2]!, calls: 0, costUsd: 0, structuredCalls: 0 };
  assert.throws(() => toRun(turns, { commit: "x", at: "y", fake: true }), /no model call/);
  const none = fixedTurns().map((turn) => ({ ...turn, calls: 0, costUsd: 0, structuredCalls: 0 }));
  assert.throws(() => toRun(none, { commit: "x", at: "y", fake: true }), /no model call/);
});

test("the run file keeps each turn's stage timings and a median and p95 per stage", () => {
  const turns = fixedTurns().map((turn, i) => ({
    ...turn,
    stages: [{ stage: "router", seconds: i + 1, startedAt: 0 }, { stage: "answer", seconds: 10, startedAt: 1 }]
  }));
  const run = toRun(turns, { commit: "x", at: "y", fake: true });
  assert.equal(run.turns.length, 20);
  assert.deepEqual(run.turns[0]!.stages.map((s) => s.stage), ["router", "answer"]);
  assert.deepEqual(run.stage_summary["router"], { count: 20, median_seconds: 10, p95_seconds: 19, total_seconds: 210 });
  assert.equal(run.stage_summary["answer"]!.total_seconds, 200);
});

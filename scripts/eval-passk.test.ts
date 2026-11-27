import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { scriptedAgent, SCRIPTED_FLAKY } from "./eval-agents";
import { demoCaseIds } from "./eval-release";
import { measure, passHatK, summarize, type Agent, type CaseRun } from "./eval-passk";
import { loadAllCases } from "./hcp-cases";

test("pass^k is the chance that k runs drawn from n all passed", () => {
  assert.equal(passHatK(5, 5), 1);
  assert.equal(passHatK(4, 5), 0, "one failure in five runs is a failure of pass^5");
  assert.equal(passHatK(0, 5), 0);
  assert.equal(passHatK(3, 3, 3), 1);
  // 4 passes in 6 runs, k = 2: C(4,2) / C(6,2) = 6 / 15.
  assert.equal(passHatK(4, 6, 2), 0.4);
  // Ten runs, nine passes, k = 5: C(9,5) / C(10,5) = 126 / 252.
  assert.equal(passHatK(9, 10, 5), 0.5);
  assert.throws(() => passHatK(2, 3, 5), /needs at least 5 runs/);
});

const expected = [
  { caseId: "A-1", slice: "s1" }, { caseId: "A-2", slice: "s1" }, { caseId: "B-1", slice: "s2" }, { caseId: "B-2", slice: "s2" }
];
// Five runs: A-1 always passes, A-2 fails once, B-1 always fails, B-2 passes four times and is missing from the fifth.
const grid = (): CaseRun[][] =>
  [0, 1, 2, 3, 4].map((run) => [
    { caseId: "A-1", passed: true },
    { caseId: "A-2", passed: run !== 3 },
    { caseId: "B-1", passed: false },
    ...(run === 4 ? [] : [{ caseId: "B-2", passed: true }])
  ]);

test("pass rate and pass^5 are worked out per slice and overall, and a case a run skipped counts as a failure", () => {
  const summary = summarize(grid(), expected);
  assert.equal(summary.runs, 5);
  assert.deepEqual(summary.per_slice.s1, { cases: 2, pass_rate: 0.9, pass_hat_5: 0.5 });
  assert.deepEqual(summary.per_slice.s2, { cases: 2, pass_rate: 0.4, pass_hat_5: 0 });
  // 5 + 4 + 0 + 4 = 13 passes of 20 case runs; only A-1 passed all five runs.
  assert.equal(summary.pass_rate, 0.65);
  assert.equal(summary.pass_hat_5, 0.25);
  assert.deepEqual(summary.flaky, ["A-2", "B-2"]);
});

test("pass^5 never exceeds the pass rate, and equals it only when a case is steady", () => {
  const steady = [0, 1, 2, 3, 4].map(() => expected.map((e) => ({ caseId: e.caseId, passed: e.caseId !== "B-1" })));
  const s = summarize(steady, expected);
  assert.equal(s.pass_rate, 0.75);
  assert.equal(s.pass_hat_5, 0.75);
  const flaky = summarize(grid(), expected);
  assert.ok(flaky.pass_hat_5 < flaky.pass_rate);
});

test("the measure runs the demo set five times on the scripted agent and writes the file the measures table reads", async () => {
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "evals-")), "evals.json");
  const calls: number[] = [];
  const base = scriptedAgent();
  const agent: Agent = { ...base, runCases: (ids, run) => (calls.push(run), base.runCases(ids, run)) };
  const run = await measure(agent, { out, commit: "abc123", now: new Date("2026-01-01T00:00:00Z") });
  assert.deepEqual(calls, [0, 1, 2, 3, 4]);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.deepEqual(written, JSON.parse(JSON.stringify(run)));
  const demo = demoCaseIds();
  // The scripted agent fails one case on one run of five, so pass_rate is that case's 4/5 averaged in and pass^5 loses the whole case.
  assert.equal(written.summary.cases, demo.length);
  assert.equal(written.measures["evals.pass_rate"], Math.round((1000 * (demo.length * 5 - 1)) / (demo.length * 5)) / 1000);
  assert.equal(written.measures["evals.pass_hat_5"], Math.round((1000 * (demo.length - 1)) / demo.length) / 1000);
  assert.deepEqual(written.summary.flaky, SCRIPTED_FLAKY.cases);
  assert.equal(written.measures["evals.sabotage_caught"], 1);
  assert.equal(written.sabotage_caught, true);
  assert.equal(written.pass_hat_5, written.measures["evals.pass_hat_5"]);
  assert.equal(Object.keys(written.pass_rate).length, new Set(loadAllCases().map((c) => c.metadata.slice)).size, "pass_rate has one entry per slice");
  assert.ok(!("evals.judge_agreement" in written.measures), "no labels, so no agreement is claimed");
  assert.equal(written.judge_agreement, null);
  assert.equal(written.commit, "abc123");
  assert.equal(written.floor.met, true);
});

test("a run that loses a case, or an agent the sabotage does not turn red, shows in the file", async () => {
  const base = scriptedAgent();
  const dropped: Agent = { ...base, runCases: async (ids, run) => (await base.runCases(ids, run)).slice(1) };
  const out = path.join(mkdtempSync(path.join(os.tmpdir(), "evals-")), "e.json");
  const a = await measure(dropped, { out, commit: "x" });
  assert.ok(a.measures["evals.pass_rate"]! < 1);
  assert.equal(a.measures["evals.pass_hat_5"]! <= (demoCaseIds().length - 2) / demoCaseIds().length, true);
  const blind = await measure({ ...base, sabotageCaught: async () => false }, { commit: "x" });
  assert.equal(blind.measures["evals.sabotage_caught"], 0);
});


test("the run file says why each failing case failed, run by run, and leaves passing cases out", () => {
  const expected = [{ caseId: "A", slice: "s" }, { caseId: "B", slice: "s" }];
  const run = (bPassed: boolean): CaseRun[] => [{ caseId: "A", passed: true }, { caseId: "B", passed: bPassed, failed: bPassed ? [] : [{ name: "label_checks", comment: "no citation to 8.1" }] }];
  const s = summarize([run(true), run(false), run(true), run(false), [{ caseId: "A", passed: true }]], expected);
  assert.deepEqual(Object.keys(s.failures), ["B"]);
  assert.equal(s.failures.B!.passed, 2);
  assert.deepEqual(s.failures.B!.runs, [[{ name: "label_checks", comment: "no citation to 8.1" }], [{ name: "label_checks", comment: "no citation to 8.1" }], [{ name: "missing", comment: "the run did not report this case" }]]);
});

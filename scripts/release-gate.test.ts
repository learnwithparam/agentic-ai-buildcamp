import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { RegressionError, type Evaluation } from "@langfuse/client";
import { loadAllCases } from "./hcp-cases";
import { assertReleasable, gatedFiles, METRIC, pushedRanges, RELEASE_CASES, releasePassRate } from "./release-gate";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const ZERO = "0".repeat(40);
const A = "a".repeat(40);
const B = "b".repeat(40);

// One fake case row: every score the pass rule asks for, at 1 or at 0.
const row = (caseId: string, passed: boolean) => ({
  item: { metadata: { caseId, slice: "staleness" } },
  output: "",
  evaluations: [
    { name: "behavior_match", value: 1 },
    { name: "label_checks", value: passed ? 1 : 0, comment: passed ? "" : "Failed: contains 5mg" }
  ]
});
const run = async (rows: ReturnType<typeof row>[]) => {
  const result = { itemResults: rows, runEvaluations: [] as Evaluation[] };
  result.runEvaluations.push(...[await releasePassRate({ itemResults: rows as never })].flat());
  return result;
};

test("every release case is a case in the dataset", () => {
  const ids = new Set(loadAllCases().map((item) => item.metadata.caseId));
  for (const id of RELEASE_CASES) assert.ok(ids.has(id), `${id} is a release case but not in the dataset`);
  assert.equal(new Set(RELEASE_CASES).size, RELEASE_CASES.length, "a release case is listed twice");
});

test("the gate is green only when every release case passes", async () => {
  const green = await run(RELEASE_CASES.map((id) => row(id, true)));
  assert.doesNotThrow(() => assertReleasable(green));

  // One release case fails, as in the lesson's red run, and the gate turns red.
  const red = await run(RELEASE_CASES.map((id) => row(id, id !== "STALENESS-01")));
  assert.equal(red.runEvaluations[0]?.name, METRIC);
  assert.equal(red.runEvaluations[0]?.comment, "Failed: STALENESS-01");
  assert.throws(() => assertReleasable(red), (error) => error instanceof RegressionError && error.value === 7 / 8);
});

test("a gate that ran fewer cases, or none, or lost its score, is red", async () => {
  assert.throws(() => assertReleasable({ itemResults: [], runEvaluations: [] }), RegressionError);
  // A provider error makes the SDK skip a case: every case that ran passed, and the gate is still red.
  assert.throws(
    () => assertReleasable({ itemResults: RELEASE_CASES.slice(1).map((id) => row(id, true)), runEvaluations: [{ name: METRIC, value: 1 }] }),
    (error) => error instanceof RegressionError && error.message === `only 7 of 8 release cases ran, and a case that did not run is never a pass`
  );
  assert.throws(() => assertReleasable({ itemResults: RELEASE_CASES.map((id) => row(id, true)), runEvaluations: [] }), RegressionError);
  // A case whose evaluator threw has no score: it fails, it does not pass.
  const lost = await run([...RELEASE_CASES.slice(1).map((id) => row(id, true)), { ...row(RELEASE_CASES[0]!, true), evaluations: [] }]);
  assert.throws(() => assertReleasable(lost), RegressionError);
});

test("a push is gated only when it changes an agent, the runner or the dataset", () => {
  assert.deepEqual(gatedFiles(["docs/learner/18-release-gate.md", "README.md", "src/client/App.tsx", "src/server/auto/sweep.test.ts"]), []);
  for (const file of ["src/server/medinfo-agent.ts", "scripts/experiment.ts", "scripts/prompt-variants.ts", "scripts/judge/faithfulness.ts", "data/hcp/evals/medinfo.yaml", "package.json"]) {
    assert.deepEqual(gatedFiles([file]), [file], `${file} must run the gate`);
  }
});

test("the hook reads branch pushes, skips tags and deletes, and compares a new branch with main", () => {
  const base = (sha: string) => `base-of-${sha}`;
  const stdin = [
    `refs/heads/ch18 ${B} refs/heads/ch18 ${A}`,
    `refs/heads/new ${B} refs/heads/new ${ZERO}`,
    `refs/tags/checkpoint/18-release-gate ${B} refs/tags/checkpoint/18-release-gate ${A}`,
    `(delete) ${ZERO} refs/heads/old ${A}`,
    ""
  ].join("\n");
  assert.deepEqual(pushedRanges(stdin, base), [
    { from: A, to: B },
    { from: `base-of-${B}`, to: B }
  ]);
});

test("npm install turns the hook on, and the hook runs the gate", () => {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
  assert.match(pkg.scripts.prepare ?? "", /git config core\.hooksPath \.githooks/);
  const hook = path.join(ROOT, ".githooks/pre-push");
  assert.ok((statSync(hook).mode & 0o111) !== 0, "the pre-push hook is not executable");
  assert.match(readFileSync(hook, "utf8"), /scripts\/release-gate\.ts --pre-push/);
  // git itself agrees the hook is executable in the tree, so a clone gets it working.
  assert.match(execFileSync("git", ["ls-files", "-s", ".githooks/pre-push"], { cwd: ROOT, encoding: "utf8" }), /^100755 /);
});

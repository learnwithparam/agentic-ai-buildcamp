import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { assertTypes, rubricCount, unhandledAsserts } from "./eval-asserts";
import { staleRubrics } from "./experiment";
import { EVALS_DIR, HANDLED_ASSERTS, loadAllCases, loadCases } from "./hcp-cases";
import { renderRubricPrompt, rubricOutcome } from "./judge/rubric";

const YAML = (assertion: string) => `defaultTest:
  vars:
    tenantId: pharma_a
    brandId: b
    country: US
tests:
  - description: "[X-01] a case"
    metadata: { slice: s, chapter: "01", riskTier: answer, split: train, expectedBehavior: reply }
    vars:
      query: "q"
    assert:
${assertion}
`;

test("no assert in any data/hcp/evals file is a type the runner does not handle", () => {
  assert.deepEqual(unhandledAsserts(), []);
  assert.ok(readdirSync(EVALS_DIR).filter((name) => name.endsWith(".yaml")).length >= 7, "the walk found too few files");
});

test("an assert type nobody handles is reported, and stops the case loader with its file and case", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "evals-"));
  writeFileSync(path.join(dir, "medinfo.yaml"), YAML("      - type: similar\n        value: x\n      - type: contains\n        value: y"));
  assert.deepEqual(unhandledAsserts(dir), ['medinfo.yaml: 1 assert(s) of type "similar" that no runner handles']);
  assert.throws(() => loadCases("medinfo", dir), /medinfo\.yaml, X-01: no runner handles the assert type similar/);
});

test("every llm-rubric assert in the files reaches the case it is written on", () => {
  const cases = loadAllCases();
  const loaded = cases.reduce((sum, item) => sum + item.expectedOutput.rubrics.length, 0);
  assert.equal(loaded, rubricCount());
  assert.ok(loaded >= 11, "the dataset holds at least 11 llm-rubric asserts");
  // The text of each rubric, word for word.
  const all = readdirSync(EVALS_DIR).map((name) => readFileSync(path.join(EVALS_DIR, name), "utf8")).join("\n");
  for (const item of cases) for (const rubric of item.expectedOutput.rubrics) assert.ok(all.includes(JSON.stringify(rubric).slice(1, -1)) || all.includes(rubric), `${item.metadata.caseId}: rubric text changed on the way in`);
});

test("the handled list is the four text checks and the rubric, and counts a default assert per test", () => {
  assert.deepEqual([...HANDLED_ASSERTS].sort(), ["contains", "llm-rubric", "not-contains", "not-regex", "regex"]);
  const counts = assertTypes("f.yaml", "defaultTest:\n  assert:\n    - type: contains\n      value: a\ntests:\n  - description: t1\n  - description: t2\n    assert:\n      - type: llm-rubric\n        value: r\n");
  assert.deepEqual(counts, [{ file: "f.yaml", type: "contains", count: 2 }, { file: "f.yaml", type: "llm-rubric", count: 1 }]);
});

test("a hosted dataset written before the rubrics were kept is named, case by case", () => {
  const local = loadAllCases();
  const withRubric = local.find((item) => item.expectedOutput.rubrics.length)!;
  const fresh = local.map((item) => ({ metadata: item.metadata, expectedOutput: item.expectedOutput }));
  assert.deepEqual(staleRubrics(fresh, local), []);
  const old = fresh.map((item) => (item.metadata.caseId === withRubric.metadata.caseId ? { ...item, expectedOutput: { ...item.expectedOutput, rubrics: undefined } } : item));
  assert.deepEqual(staleRubrics(old, local), [`${withRubric.metadata.caseId} has 0 rubric(s) in Langfuse and ${withRubric.expectedOutput.rubrics.length} in the yaml`]);
});

test("the rubric judge's prompt carries the question, the rubric and the answer, and one failed rubric fails the case", () => {
  const prompt = renderRubricPrompt("Is 5mg ok?", "Says 5mg.", "Yes, 5mg $& done");
  for (const part of ["Is 5mg ok?", "Says 5mg.", "Yes, 5mg $& done"]) assert.ok(prompt.includes(part));
  assert.ok(!prompt.includes("{{"), "a placeholder was left in the prompt");
  assert.deepEqual(rubricOutcome(["a", "b"], [{ score: true, reasoning: "ok" }, { score: true, reasoning: "ok" }]), { score: true, comment: "All 2 rubric(s) met." });
  const failed = rubricOutcome(["a", "b"], [{ score: true, reasoning: "ok" }, { score: false, reasoning: "no dose" }]);
  assert.equal(failed.score, false);
  assert.match(failed.comment, /"b": no dose/);
  assert.equal(rubricOutcome(["a"], []).score, false, "a rubric with no verdict is a failure");
});

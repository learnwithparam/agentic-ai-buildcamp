import assert from "node:assert/strict";
import { test } from "node:test";
import { numberProblems, resolvePath } from "./page-numbers";

// The numbers on a page come from runs. A number followed by <!-- from: file#path --> must equal
// that run value at the digits the page shows. These tests are offline: the run files are made up.

const runs: Record<string, unknown> = {
  "docs/runs/x.json": { passed: 22, total: 28, measures: { "search.recall_at_5": 0.952 }, configs: { hybrid: { all: { mrr: 0.933 } } } }
};
const read = (file: string) => runs[file] ?? null;
const check = (page: string) => numberProblems("docs/learner/x.md", page, read);

test("a number that equals its run value passes, at the precision the page shows", () => {
  assert.deepEqual(check("It passed 22<!-- from: docs/runs/x.json#passed --> of 28<!-- from: docs/runs/x.json#total -->."), []);
  assert.deepEqual(check("Recall was 0.95<!-- from: docs/runs/x.json#measures.search.recall_at_5 -->."), []);
  assert.deepEqual(check("Recall was 0.952<!-- from: docs/runs/x.json#measures.search.recall_at_5 -->."), []);
  assert.deepEqual(check("Recall was 95%<!-- from: docs/runs/x.json#measures.search.recall_at_5 -->."), []);
  assert.deepEqual(check("MRR 0.933<!-- from: docs/runs/x.json#configs.hybrid.all.mrr -->."), []);
});

test("a wrong number fails, and says what the run holds", () => {
  assert.match(check("It passed 23<!-- from: docs/runs/x.json#passed -->.").join("\n"), /says 23, docs\/runs\/x.json#passed holds 22/);
  assert.match(check("Recall was 0.96<!-- from: docs/runs/x.json#measures.search.recall_at_5 -->.").join("\n"), /says 0.96/);
  assert.match(check("Recall was 94%<!-- from: docs/runs/x.json#measures.search.recall_at_5 -->.").join("\n"), /says 94%/);
});

test("a missing path, a missing file and a value that is not a number fail", () => {
  assert.match(check("It passed 22<!-- from: docs/runs/x.json#nope -->.").join("\n"), /no number at docs\/runs\/x.json#nope/);
  assert.match(check("It passed 22<!-- from: docs/runs/gone.json#passed -->.").join("\n"), /docs\/runs\/gone.json does not exist/);
  assert.match(check("It passed 22<!-- from: docs/runs/x.json#measures -->.").join("\n"), /no number at/);
});

test("a comment with no number before it fails", () => {
  assert.match(check("It passed <!-- from: docs/runs/x.json#passed -->.").join("\n"), /no number right before/);
});

test("a key that holds dots resolves by the longest match", () => {
  assert.equal(resolvePath(runs["docs/runs/x.json"], "measures.search.recall_at_5"), 0.952);
  assert.equal(resolvePath(runs["docs/runs/x.json"], "measures.search"), undefined);
});

// A scoreboard row copied onto a page ends with <!-- from-row: file -->. Each cell must equal the run's tally.
const board = {
  "docs/runs/scoreboard-07.json": { chapter: "07", passed: 22, total: 28, slices: { staleness: { passed: 3, total: 3 }, tenancy: { passed: 2, total: 4 } } }
};
const rows = (row: string) =>
  numberProblems("docs/learner/x.md", `| Chapter | Change | Passed | staleness | tenancy | rag |\n| --- | --- | --- | --- | --- | --- |\n${row}\n`, (file) => (board as Record<string, unknown>)[file] ?? null);

test("a table row that matches its run file passes, with a dash for a slice the run left out", () => {
  assert.deepEqual(rows("| 07 | Prompt | 22/28 | 3/3 | 2/4 | - | <!-- from-row: docs/runs/scoreboard-07.json -->"), []);
});

test("a table row with a wrong cell, a wrong chapter or an invented slice fails", () => {
  assert.match(rows("| 07 | Prompt | 23/28 | 3/3 | 2/4 | - | <!-- from-row: docs/runs/scoreboard-07.json -->").join("\n"), /"Passed" says 23\/28, the run holds 22\/28/);
  assert.match(rows("| 07 | Prompt | 22/28 | 3/3 | 3/4 | - | <!-- from-row: docs/runs/scoreboard-07.json -->").join("\n"), /"tenancy" says 3\/4/);
  assert.match(rows("| 08 | Prompt | 22/28 | 3/3 | 2/4 | - | <!-- from-row: docs/runs/scoreboard-07.json -->").join("\n"), /chapter 08/);
  assert.match(rows("| 07 | Prompt | 22/28 | 3/3 | 2/4 | 1/1 | <!-- from-row: docs/runs/scoreboard-07.json -->").join("\n"), /"rag" says 1\/1, the run holds -/);
  assert.match(rows("| 07 | Prompt | 22/28 | 3/3 | 2/4 | - | <!-- from-row: docs/runs/none.json -->").join("\n"), /none.json does not exist/);
});

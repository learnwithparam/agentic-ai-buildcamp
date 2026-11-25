import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { failedChecks, loadAllCases, loadMedinfoCases } from "./hcp-cases";
import { appendScoreboardRow, checkScoreboard, headerRow, LEARNER_SCOREBOARD_FILE, SCOREBOARD_FILE, scoreboardRow, slices } from "./scoreboard";

test("text checks read bold doses and spaced units the way the dataset writes them", () => {
  const checks = [
    { type: "contains" as const, value: "2.5mg" },
    { type: "not-regex" as const, value: "(^|[^\\d.])5mg once" },
    { type: "regex" as const, value: "\\[cardionex-de-smpc,\\s*2\\.2" }
  ];
  assert.deepEqual(failedChecks("Give **2.5 mg** once daily [cardionex-de-smpc, 2.2].", checks), []);
  assert.deepEqual(failedChecks("Give 5 mg once daily [cardionex-uspi-v2, 2.2].", checks).length, 3);
});

test("every ideal answer passes its own checks, tokens aside", () => {
  const token = /^[A-Z][A-Z_]+$/;
  for (const item of loadMedinfoCases()) {
    const checks = item.expectedOutput.checks.filter((check) => !token.test(check.value));
    assert.deepEqual(failedChecks(item.expectedOutput.idealAnswer, checks), [], item.id);
  }
});

test("every case carries the dataset's text checks, including the global leak checks", () => {
  for (const item of loadAllCases()) {
    assert.ok(item.expectedOutput.checks.some((check) => check.value === "1043298112"), item.id);
  }
});

test("a scoreboard row has one cell per slice and the check rejects a short row", () => {
  const row = scoreboardRow("06", "Naive agent", [{ slice: slices()[0], passed: true }], "http://run");
  const table = `${headerRow()}\n|---|\n${row}\n`;
  assert.deepEqual(checkScoreboard(table), []);
  assert.equal(checkScoreboard(`${table}| 07 | short | 1/1 |\n`).length, 1);
});

test("a learner's row goes to their own file, which starts with the reference header", () => {
  assert.notEqual(LEARNER_SCOREBOARD_FILE, SCOREBOARD_FILE);
  assert.match(readFileSync(path.resolve(".gitignore"), "utf8"), /^my-scoreboard\.md$/m);
  const file = path.join(mkdtempSync(path.join(tmpdir(), "scoreboard-")), "my-scoreboard.md");
  const row = scoreboardRow("06", "Naive agent", [{ slice: slices()[0], passed: true }], "http://run");
  appendScoreboardRow(row, file);
  appendScoreboardRow(row, file);
  assert.deepEqual(checkScoreboard(readFileSync(file, "utf8")), []);
  assert.equal(readFileSync(file, "utf8").split("\n").filter((line) => line === row).length, 2);
});

test("a slice the run left out shows a dash, not 0 passed", () => {
  const [first, second] = slices();
  const cells = scoreboardRow("09", "Subset", [{ slice: first, passed: true }], "http://run").split("|").map((cell) => cell.trim());
  assert.equal(cells[4], "1/1");
  assert.equal(cells[3 + slices().indexOf(second) + 1], "-");
});

// The runner refuses an id that is not in the dataset, so a lesson that names one gives the
// learner a command that fails. Every --cases list in every lesson page must name real cases.
// The ids come from every file in the dataset copy, not from this tag's loader: every tag carries
// main's lesson pages and data, but an earlier tag's loader does not read a later lesson's file.
test("every --cases id a lesson page names is a case in the dataset", () => {
  const evals = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../data/hcp/evals");
  const ids = new Set(
    readdirSync(evals)
      .filter((name) => name.endsWith(".yaml"))
      .flatMap((name) => [...readFileSync(path.join(evals, name), "utf8").matchAll(/^\s*- description: "\[([A-Z0-9-]+)\]/gm)].map((match) => match[1]))
  );
  for (const item of loadAllCases()) assert.ok(ids.has(item.metadata.caseId), `the loader has ${item.metadata.caseId}, which the id pattern missed`);
  const learner = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../docs/learner");
  const pages = readdirSync(learner).filter((name) => name.endsWith(".md"));
  let lists = 0;
  for (const page of pages) {
    for (const [, list] of readFileSync(path.join(learner, page), "utf8").matchAll(/--cases\s+([A-Z0-9,-]+)/g)) {
      lists += 1;
      for (const id of list.split(",")) assert.ok(ids.has(id), `${page} names ${id}, which is not in the dataset`);
    }
  }
  assert.ok(lists > 0, "no lesson page names a --cases list; the pattern no longer matches");
});

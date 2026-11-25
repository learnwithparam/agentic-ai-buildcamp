import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkCitations } from "../src/server/citations";
import { REPLAY_FILE, type ReplayedAnswer } from "./citations-replay";

// Lesson 21. data/evidence/citations-replay.json is what the real model did when the cite node
// ran on the stored answers that fail the check (npm run citations:replay, each answer with its
// Langfuse trace). The check runs again here on the model's own text, with no model call.
const { answers } = JSON.parse(readFileSync(REPLAY_FILE, "utf8")) as { answers: ReplayedAnswer[] };

test("the replay covers stored answers that each fail the check", () => {
  assert.ok(answers.length > 0);
  for (const row of answers) {
    assert.match(row.replayTrace, /^[0-9a-f]{32}$/);
    assert.deepEqual(row.problems, checkCitations(row.answer, row.retrieved, row.asked), row.storedTrace);
    assert.ok(row.problems.length, row.storedTrace);
  }
});

test("a rewritten answer passes the check, and a withheld one failed it twice", () => {
  for (const row of answers) {
    const again = checkCitations(row.rewrite, row.retrieved, row.asked);
    assert.deepEqual(again, row.afterRewrite, row.storedTrace);
    assert.equal(row.outcome, again.length ? "withheld" : "rewritten", row.storedTrace);
  }
});

test("no rewrite cites the expired draft", () => {
  for (const row of answers) assert.doesNotMatch(row.rewrite, /cardionex-draft-2024/, row.storedTrace);
});

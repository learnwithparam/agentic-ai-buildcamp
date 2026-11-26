import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatMessage } from "./messages";
import { answerRun } from "./run";

// Step 2B. The record under each reply holds only this turn's lookups, each with the sections and
// scores it found, and says in plain words what the citation check stopped.
const search = (id: string, query: string, results: unknown[]): ChatMessage[] => [
  { id: `call-${id}`, type: "ai", content: [], tool_calls: [{ id, name: "search_labels", args: { query, country: "US" } }] },
  { id: `tool-${id}`, type: "tool", tool_call_id: id, name: "search_labels", content: JSON.stringify({ ok: true, results }), status: "success" }
];
const hit = { doc_id: "cardionex-uspi-v2", section: "2.2", score: 0.61, status: "active", country: "US", title: "Renal", text: "5 mg" };

test("a reply's record holds this turn's searches with their scores, not an earlier turn's", () => {
  const messages: ChatMessage[] = [
    { id: "q1", type: "human", content: "Dose for eGFR 24?" },
    ...search("a", "eGFR 24 dose", [hit]),
    { id: "r1", type: "ai", content: [{ type: "text", text: "5 mg [cardionex-uspi-v2, 2.2]" }], tool_calls: [] },
    { id: "q2", type: "human", content: "With spironolactone?" },
    ...search("b", "spironolactone potassium", [{ ...hit, section: "7.1", score: 0.82 }, { ...hit, doc_id: "cardionex-uspi-v1", section: "7.1", status: "superseded" }])
  ];
  const run = answerRun(messages, { tier: "answer", reason: "asks about an interaction" }, { outcome: "passed", problems: [] });
  assert.equal(run.lookups.length, 1);
  assert.equal(run.lookups[0].asked, "spironolactone potassium, US");
  assert.deepEqual(run.lookups[0].hits.map((found) => [found.doc_id, found.section, found.score, found.status]), [
    ["cardionex-uspi-v2", "7.1", 0.82, "active"],
    ["cardionex-uspi-v1", "7.1", 0.61, "superseded"]
  ]);
  assert.equal(run.check?.outcome, "passed");
});

test("the check's problems read as plain words, and a turn with no tools has no lookups", () => {
  const messages: ChatMessage[] = [{ id: "q", type: "human", content: "Dose?" }];
  const run = answerRun(messages, { tier: "answer", reason: "" }, {
    outcome: "rewritten",
    problems: [{ kind: "not_in_force", citation: "cardionex-uspi-v1, 2.2", status: "superseded" }, { kind: "uncited", quantity: "5 mg", sentence: "Give 5 mg." }]
  });
  assert.deepEqual(run.lookups, []);
  assert.deepEqual(run.check?.problems, ["cited [cardionex-uspi-v1, 2.2], which is superseded and not in force today", "gave 5 mg with no citation"]);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { storedTurns } from "./citations-audit";

// Lesson 21. The audit reads the model's own answer: the last agent generation that wrote text,
// not a tool request, not the router, and not the rewrite the check asked for.
test("the audit pairs each turn's search results with the agent's first written answer", () => {
  const section = { doc_id: "cardionex-uspi-v2", section: "8.2", status: "active", text: "for 5 days" };
  const input = JSON.stringify({ messages: [{ role: "system", content: "rules" }, { role: "user", content: "Nursing?" }] });
  const turns = storedTurns(
    [{ traceId: "t1", name: "search_labels", startTime: "1", input: JSON.stringify({ query: "CardioNex nursing" }), output: JSON.stringify({ ok: true, results: [section] }) }],
    [
      { traceId: "t1", name: "OpenAI.chat", startTime: "2", input, output: JSON.stringify({ tool_calls: [{ function: { name: "search_labels" } }] }) },
      { traceId: "t1", name: "OpenAI.chat", startTime: "3", input, output: "Wait 5 days [cardionex-uspi-v2, 8.2]." },
      { traceId: "t1", name: "citation-rewrite", startTime: "4", input, output: "rewritten" },
      { traceId: "t2", name: "OpenAI.chat", startTime: "5", input, output: "No search in this turn." }
    ]
  );
  assert.deepEqual(turns, [{ traceId: "t1", asked: "Nursing?", answer: "Wait 5 days [cardionex-uspi-v2, 8.2].", retrieved: [section], searches: [{ query: "CardioNex nursing", results: [section] }] }]);
});

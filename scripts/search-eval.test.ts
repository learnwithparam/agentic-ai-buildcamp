import assert from "node:assert/strict";
import { test } from "node:test";
import { average, scoreQuestion, type Gold } from "./search-eval";

const gold = (kind: string, relevant: Gold["relevant"]): Gold => ({ id: "t", tenant_id: "pharma_a", as_of: "2026-11-26", country: "US", history: [], query: "q", kind, relevant });
const dose = gold("direct", [
  { doc_id: "a", section: "2.2", grade: 2 },
  { doc_id: "b", section: "1.7", grade: 2 },
  { doc_id: "a", section: "2.1", grade: 1 }
]);

test("a perfect ranking scores 1 on every measure", () => {
  assert.deepEqual(scoreQuestion(dose, ["a 2.2", "b 1.7", "a 2.1"]), { recall_at_5: 1, mrr: 1, ndcg_at_10: 1 });
});

test("an answer found second halves the reciprocal rank, and a missing one halves recall", () => {
  const s = scoreQuestion(dose, ["a 2.1", "a 2.2", "x 9"]);
  assert.equal(s.recall_at_5, 0.5);
  assert.equal(s.mrr, 0.5);
  assert.ok(s.ndcg_at_10! > 0 && s.ndcg_at_10! < 1);
});

test("a helping section is not an answer: recall counts grade 2 only", () => {
  assert.deepEqual(scoreQuestion(dose, ["a 2.1"]).recall_at_5, 0);
  assert.equal(scoreQuestion(dose, ["a 2.1"]).mrr, 0);
});

test("an answer past the top 5 does not count for recall", () => {
  assert.equal(scoreQuestion(dose, ["x 1", "x 2", "x 3", "x 4", "x 5", "a 2.2", "b 1.7"]).recall_at_5, 0);
});

test("an out-of-label question scores only whether the search said it has nothing", () => {
  const none = gold("out_of_label", []);
  assert.deepEqual(scoreQuestion(none, []), { out_of_label_empty: 1 });
  assert.deepEqual(scoreQuestion(none, ["a 2.2"]), { out_of_label_empty: 0 });
  assert.deepEqual(average([{ out_of_label_empty: 1 }, { out_of_label_empty: 0 }, { recall_at_5: 1 }]), { out_of_label_empty: 0.5, recall_at_5: 1 });
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { labelJudge, readGold, runRow, score, type RowResult } from "./citations-eval";

// The arithmetic of npm run citations:measure, proven with no model: the judge repeats each row's
// label (--fake), and score() is checked by hand on a small set.
const row = (label: string, code: string | null, judge: "supported" | "unsupported", verbatim = true): RowResult => ({ id: label, label, code, verbatim, judge });

test("precision, recall and the verbatim rate, by hand", () => {
  const results = [
    row("supported", null, "supported"), // passed: right
    row("supported", null, "unsupported"), // flagged though supported: a false alarm
    row("unsupported", null, "unsupported"), // caught by the judge
    row("unsupported", null, "supported"), // missed
    row("fabricated_quote", "quote_not_in_section", "supported", false), // caught by code
    row("wrong_number", "number_not_in_quote", "unsupported") // caught by both
  ];
  const scored = score(results);
  assert.equal(scored.hallucination_precision, 0.75); // 3 of the 4 flagged rows are not supported
  assert.equal(scored.hallucination_recall, 0.75); // 3 of the 4 not-supported rows are flagged
  assert.equal(scored.quote_verbatim_rate, 1); // 5 real quotes, all found; the fabricated one is left out
  assert.equal(scored.by_label.unsupported!.judge_agreement, 0.5);
  assert.deepEqual(scored.misses.map((miss) => miss.label), ["supported", "unsupported"]);
});

test("a real quote the check rejects lowers the verbatim rate", () => {
  assert.equal(score([row("supported", null, "supported", true), row("supported", "quote_not_in_section", "supported", false)]).quote_verbatim_rate, 0.5);
});

test("over the gold file with the label judge, the code checks alone cost no precision and the judge finds the rest", async () => {
  const rows = readGold();
  assert.equal(rows.length, 116);
  const scored = score(await Promise.all(rows.map((r) => runRow(r, labelJudge(rows)))));
  assert.equal(scored.hallucination_precision, 1);
  assert.equal(scored.hallucination_recall, 1);
  assert.equal(scored.quote_verbatim_rate, 1);
  // The code checks catch every fabricated, wrong-version and wrong-country row without the judge.
  for (const label of ["fabricated_quote", "wrong_version", "wrong_country"]) assert.equal(scored.by_label[label]!.flagged_by_code, scored.by_label[label]!.rows, label);
});

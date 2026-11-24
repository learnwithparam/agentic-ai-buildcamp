import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_SECTIONS, approvedCountries, searchLabels } from "./labels";

// Lesson 11. Search scores only the documents it is given; which ones a doctor may read is
// OpenFGA's answer, tested against the real server in src/server/permissions.test.ts.

test("search never returns a document outside the readable set", () => {
  const readable = new Set(["cardionex-uspi-v2"]);
  const hits = searchLabels("CardioNex dose NeuroVex dizziness", readable, LABEL_SECTIONS.length);
  assert.ok(hits.length > 0);
  assert.deepEqual([...new Set(hits.map((hit) => hit.docId))], ["cardionex-uspi-v2"]);
  assert.deepEqual(searchLabels("CardioNex starting dose", new Set()), []);
});

test("the desk rules know where each company has text in force", () => {
  assert.deepEqual(approvedCountries("pharma_a"), ["DE", "JP", "US"]);
  assert.deepEqual(approvedCountries("pharma_b"), ["US"]);
});

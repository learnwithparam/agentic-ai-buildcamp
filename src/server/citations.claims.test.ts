import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_REASONS, describeProblem } from "./citations";
import { checkClaim, quoteIsVerbatim, reviewClaims, sectionText, type Claim, type Judge } from "./citations.claims";
import { noModelCall } from "../../scripts/no-model-call";
import { readGold, type GoldClaim } from "../../scripts/citations-eval";

// Lesson 21, claim by claim. The code checks need no model. The support judge is a model call, so
// its promise is proven on the real model (citations.claims.live.ts); here the judge is a plain
// function that must not be reached, or that answers a fixed way to show what the code does with it.
const gold = readGold();
const claimOf = (row: GoldClaim): Claim => ({ text: row.claim, quote: row.quote, docId: row.doc_id, section: row.section });
const check = (row: GoldClaim) => checkClaim(claimOf(row), { retrieved: null, today: row.as_of, country: row.country });
const never: Judge = async () => noModelCall();

test("every real quote in the gold file is found verbatim, and no fabricated quote is", () => {
  for (const row of gold) assert.equal(quoteIsVerbatim(claimOf(row)), row.label !== "fabricated_quote", row.id);
});

test("a fabricated quote fails the code check", () => {
  for (const row of gold.filter((r) => r.label === "fabricated_quote")) assert.equal(check(row), "quote_not_in_section", row.id);
});

test("a real quote with one word changed is not verbatim", () => {
  const [row] = gold.filter((r) => r.label === "supported");
  const words = row!.quote.split(" ");
  words[Math.floor(words.length / 2)] = "banana";
  assert.equal(quoteIsVerbatim({ ...claimOf(row!), quote: words.join(" ") }), false);
});

test("whitespace and case are the only things folded", () => {
  const found = sectionText("cardionex-uspi-v2", "2.2")!;
  const claim = { docId: "cardionex-uspi-v2", section: "2.2", quote: found.text.slice(0, 60).toUpperCase().replace(/ /g, "\n  ") };
  assert.equal(quoteIsVerbatim(claim), true);
  assert.equal(quoteIsVerbatim({ ...claim, quote: `${claim.quote}.` }), false);
});

test("a number in the claim that is not in the quote fails", () => {
  for (const row of gold.filter((r) => r.label === "wrong_number" && check(r) === "number_not_in_quote")) {
    assert.equal(quoteIsVerbatim(claimOf(row)), true, row.id);
  }
  const row = gold.find((r) => r.id === "c-005")!;
  assert.equal(check(row), null);
  assert.equal(checkClaim({ ...claimOf(row), text: "In CLARION-HF the dose was raised to 80 mg after 4 weeks." }, { retrieved: null, today: row.as_of }), "number_not_in_quote");
});

test("a number the doctor gave, and a digit inside a name, are not claims from the label", () => {
  const row = gold.find((r) => r.id === "c-005")!;
  const today = row.as_of;
  const withGiven = { ...claimOf(row), text: "For eGFR 24, in CLARION-HF the dose was raised to 40 mg after 4 weeks." };
  assert.equal(checkClaim(withGiven, { retrieved: null, today }), "number_not_in_quote");
  assert.equal(checkClaim(withGiven, { retrieved: null, today, given: new Set([24]) }), null);
  const cyp = gold.find((r) => r.id === "c-023")!;
  assert.equal(check(cyp), null);
});

test("a superseded document fails the in-force rule, and the same section passes on the day it was in force", () => {
  const rows = gold.filter((r) => r.label === "wrong_version");
  assert.ok(rows.length > 0);
  for (const row of rows) assert.equal(check(row), "not_in_force", row.id);
  // Version 3 comes into force on 2027-03-01: refused before, accepted after, and version 2 the reverse.
  const v3 = rows.find((r) => r.doc_id === "cardionex-uspi-v3")!;
  assert.notEqual(checkClaim(claimOf(v3), { retrieved: null, today: "2027-03-02" }), "not_in_force");
  const v2 = rows.find((r) => r.doc_id === "cardionex-uspi-v2")!;
  assert.equal(checkClaim(claimOf(v2), { retrieved: null, today: "2027-03-02" }), "not_in_force");
});

test("a document for another country fails", () => {
  for (const row of gold.filter((r) => r.label === "wrong_country")) assert.equal(check(row), "wrong_country", row.id);
});

test("a section no search returned this turn fails; one it returned passes", () => {
  const row = gold.find((r) => r.id === "c-005")!;
  const found = sectionText(row.doc_id, row.section)!;
  const section = { doc_id: row.doc_id, section: row.section, status: "active", text: found.text };
  assert.equal(checkClaim(claimOf(row), { retrieved: [], today: row.as_of }), "not_retrieved");
  assert.equal(checkClaim(claimOf(row), { retrieved: [section], today: row.as_of }), null);
  assert.equal(checkClaim({ ...claimOf(row), section: "99.99" }, { retrieved: [section], today: row.as_of }), "unknown_section");
});

test("a claim that fails a code check never reaches the judge", async () => {
  const fabricated = gold.filter((r) => r.label === "fabricated_quote").map(claimOf);
  const problems = await reviewClaims(fabricated, { retrieved: null, today: "2026-11-26" }, never);
  assert.equal(problems.length, fabricated.length);
});

test("a claim whose quote passes is judged, and an unsupported verdict is a problem with its reason", async () => {
  const row = gold.find((r) => r.id === "c-005")!;
  const answers: Judge = async () => "unsupported";
  const [problem] = await reviewClaims([claimOf(row)], { retrieved: null, today: row.as_of }, answers);
  assert.deepEqual(problem, { kind: "claim", reason: "quote_does_not_support", citation: `${row.doc_id}, ${row.section}`, claim: row.claim });
  assert.deepEqual(await reviewClaims([claimOf(row)], { retrieved: null, today: row.as_of }, async () => "supported"), []);
  assert.match(describeProblem(problem!), /the quote does not support the claim/);
  assert.ok(Object.keys(CLAIM_REASONS).length >= 7);
});

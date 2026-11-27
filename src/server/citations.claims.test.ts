import assert from "node:assert/strict";
import { test } from "node:test";
import { CLAIM_REASONS, describeProblem } from "./citations";
import { checkClaim, ELISION, offeredSections, quoteFrom, quoteIsVerbatim, reviewClaims, sectionText, sentencesOf, type Claim, type Judge, sourceOf } from "./citations.claims";
import { LABEL_SECTIONS } from "./labels";
import { passages } from "./rag/chunk";
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

test("the judge reads the quote inside its section: the document, its country and the section text", () => {
  const source = sourceOf({ docId: "neurovex-jp-label", section: "2.1" });
  assert.match(source, /neurovex-jp-label \(JP\) 2\.1/);
  assert.match(source, /25mg twice daily/);
  assert.match(sourceOf({ docId: "nope", section: "9" }), /not found/);
});

// The claim listing names sentence numbers and code copies the sentences. That only holds if every
// sentence code cuts from a search passage is in its section word for word, for every label.
test("every sentence of every search passage, alone or with its neighbour, is verbatim in its section", () => {
  let count = 0;
  for (const section of LABEL_SECTIONS) {
    for (const passage of passages(section.text)) {
      const sentences = sentencesOf(passage);
      for (let n = 1; n <= sentences.length; n++) {
        const at = { docId: section.docId, section: section.section };
        assert.ok(quoteIsVerbatim({ ...at, quote: quoteFrom(sentences, [n]) }), `${section.docId} ${section.section} sentence ${n}`);
        if (n > 1) assert.ok(quoteIsVerbatim({ ...at, quote: quoteFrom(sentences, [n - 1, n]) }), `${section.docId} ${section.section} sentences ${n - 1}-${n}`);
        count++;
      }
    }
  }
  assert.ok(count > 500, `only ${count} sentences: the labels did not load`);
});

test("a table row, a list item and a paragraph are each their own sentence, in every label", () => {
  assert.deepEqual(sentencesOf("| Dose | Note |\n| 5mg once daily | Do not titrate |\n\n**Footnote:** Applies to all."), ["| Dose | Note |", "| 5mg once daily | Do not titrate |", "**Footnote:** Applies to all."]);
  const spanning = LABEL_SECTIONS.flatMap((section) => sentencesOf(section.text).filter((sentence) => sentence.includes("\n")).map(() => `${section.docId} ${section.section}`));
  assert.deepEqual(spanning, []);
});

test("sentences split at a full stop before a capital, never inside 2.5 mg or a bracketed reference", () => {
  assert.deepEqual(sentencesOf("Start at 2.5 mg once daily. Do not exceed 10 mg [see Warnings (5.1)]. Monitor potassium."), [
    "Start at 2.5 mg once daily.",
    "Do not exceed 10 mg [see Warnings (5.1)].",
    "Monitor potassium."
  ]);
});

test("a quote is built from sentence numbers: neighbours joined, a gap elided, a number out of range dropped", () => {
  const sentences = ["One.", "Two.", "Three.", "Four."];
  assert.equal(quoteFrom(sentences, [2, 1]), "One. Two.");
  assert.equal(quoteFrom(sentences, [1, 3, 4]), `One.${ELISION}Three. Four.`);
  assert.equal(quoteFrom(sentences, [0, 9, 2.5]), "");
});

test("an elided quote passes only when every part is in the section", () => {
  const section = LABEL_SECTIONS.find((s) => sentencesOf(s.text).length >= 3)!;
  const [first, , third] = sentencesOf(section.text);
  const at = { docId: section.docId, section: section.section };
  assert.ok(quoteIsVerbatim({ ...at, quote: `${first}${ELISION}${third}` }));
  assert.equal(quoteIsVerbatim({ ...at, quote: `${first}${ELISION}A sentence the label never had.` }), false);
});

test("the claim listing is offered only sections in force, so a current fact is never credited to an old label", () => {
  const section = (docId: string) => {
    const found = LABEL_SECTIONS.find((s) => s.docId === docId)!;
    return { doc_id: found.docId, section: found.section, status: "active", text: found.text };
  };
  const retrieved = [section("cardionex-uspi-v2"), section("cardionex-uspi-v3")];
  // v3 comes into force on 2027-03-01: before it only v2 is offered, after it only v3.
  assert.deepEqual(offeredSections(retrieved, "2026-11-23").map((s) => s.doc_id), ["cardionex-uspi-v2"]);
  assert.deepEqual(offeredSections(retrieved, "2027-03-02").map((s) => s.doc_id), ["cardionex-uspi-v3"]);
});

test("the dates of a sentence are read in the forms a doctor writes them", async () => {
  const { datesIn } = await import("./citations.dates");
  assert.deepEqual(datesIn("It takes effect March 1, 2027; today's took effect 15 September 2026."), { days: ["2027-03-01", "2026-09-15"], years: [] });
  assert.deepEqual(datesIn("The 2027 label, in force from 2027-03-01."), { days: ["2027-03-01"], years: ["2027"] });
  assert.deepEqual(datesIn("Raise to 40 mg after 4 weeks."), { days: [], years: [] });
});

// FUTURE-01, 27 Nov 2026: "the approved 2027 label takes effect March 1, 2027" has no sentence in
// any section, so it was withheld for a quote that cannot exist. It is checked against the dates.
test("a version date is checked against the label's real effective dates, never by the judge", async () => {
  const reasonOf = (problem: unknown) => (problem as { reason?: string } | undefined)?.reason;
  const at = (text: string): Claim => ({ text, quote: "", docId: "cardionex-uspi-v2", section: "2.2", about: "version_date" });
  const context = { retrieved: null, today: "2026-11-23" };
  assert.deepEqual(await reviewClaims([at("The approved 2027 label takes effect March 1, 2027."), at("Today's label took effect September 15, 2026.")], context, noModelCall), []);
  const [wrong] = await reviewClaims([at("The approved label takes effect June 1, 2027.")], context, noModelCall);
  assert.equal(reasonOf(wrong), "date_not_a_version");
  const [year] = await reviewClaims([at("The 2028 label is approved.")], context, noModelCall);
  assert.equal(reasonOf(year), "date_not_a_version");
  // A NeuroVex date is not a CardioNex version.
  const neurovex = LABEL_SECTIONS.find((s) => s.docId.startsWith("neurovex") && s.country === "US")!;
  const [other] = await reviewClaims([at(`The label takes effect ${neurovex.effectiveDate}.`)], context, noModelCall);
  assert.equal(reasonOf(other), "date_not_a_version", neurovex.effectiveDate);
});

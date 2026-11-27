// Lesson 21, claim by claim, on the real model through the gateway (npm run check:live).
// The support judge and the claim listing are model calls, so what they promise is proven here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readGold } from "../../scripts/citations-eval";
import { claimCheckWith, extractClaims, judgeWithModel } from "./citations.claims";
import { modelClient } from "./gateway";
import { checkClaim, quoteIsVerbatim, sectionText } from "./citations.claims";

const gold = readGold();

test("the judge says supported for a supported gold row and unsupported for one whose quote says the opposite", async () => {
  const judge = judgeWithModel(modelClient());
  const supported = gold.find((r) => r.id === "c-005")!;
  const opposite = gold.find((r) => r.id === "c-003")!;
  assert.equal(await judge({ text: supported.claim, quote: supported.quote, docId: supported.doc_id, section: supported.section }), "supported");
  assert.equal(await judge({ text: opposite.claim, quote: opposite.quote, docId: opposite.doc_id, section: opposite.section }), "unsupported");
});

test("every claim listed from an answer names a section that was given, and a copied quote passes the verbatim check", async () => {
  const section = sectionText("cardionex-uspi-v2", "2.2")!;
  const retrieved = [{ doc_id: section.docId, section: section.section, status: "active", text: section.text }];
  // A fact the section states. An answer that states no fact has no claim to list.
  const answer = `For a standard adult with an eGFR of 30 mL/min or more, the starting dose is 20 mg once daily [${section.docId}, ${section.section}].`;
  const claims = await extractClaims(modelClient(), answer, retrieved);
  assert.ok(claims.length > 0);
  for (const claim of claims) {
    assert.deepEqual([claim.docId, claim.section], [section.docId, section.section]);
    assert.ok(quoteIsVerbatim(claim), claim.quote);
    assert.equal(checkClaim(claim, { retrieved, today: "2026-11-23" }), null, claim.text);
  }
});

test("an answer with a fact the label does not state is flagged by the claim check", async () => {
  const section = sectionText("cardionex-uspi-v2", "2.2")!;
  const retrieved = [{ doc_id: section.docId, section: section.section, status: "active", text: section.text }];
  const check = claimCheckWith(modelClient());
  const problems = await check(`CardioNex is safe to give to children under two [${section.docId}, ${section.section}].`, retrieved, "Can a toddler take it?", "2026-11-26");
  assert.ok(problems.length > 0);
});

// Seen once on 27 Nov 2026 (INJECTION-02): the FAQ section holds a planted note to the assistant,
// and the judge called a verbatim sentence of it unsupported, so a right answer was withheld. Three
// judge calls passed on the old prompt too, so this guards the data rule; it did not reproduce it.
test("a planted instruction in the section does not turn the judge against a verbatim quote", async () => {
  const judge = judgeWithModel(modelClient());
  const claim = { text: "Do not take two doses in one day.", quote: "Do not take two doses in one day.", docId: "cardionex-medinfo-faq", section: "1.2" };
  assert.match(sectionText(claim.docId, claim.section)!.text, /SYSTEM NOTE TO ASSISTANT/);
  for (let run = 0; run < 3; run++) assert.equal(await judge(claim), "supported");
});

// Seen 27 Nov 2026 on STALENESS-03: "the label does not give 50 mg twice daily" was listed with no
// quote, since no sentence states an absence, and a right answer was withheld.
test("a dose the label does not give is checked by the dose it does give", async () => {
  const section = sectionText("cardionex-uspi-v2", "2.2")!;
  const retrieved = [{ doc_id: section.docId, section: section.section, status: "active", text: section.text }];
  const check = claimCheckWith(modelClient());
  const answer = `No. The label does not give 50 mg twice daily. For a standard adult with an eGFR of 30 mL/min or more, it starts at 20 mg once daily [${section.docId}, ${section.section}].`;
  assert.deepEqual(await check(answer, retrieved, "Was CardioNex approved at 50mg twice daily?", "2026-11-23"), []);
});

// FUTURE-01, 27 Nov 2026: the date a newer label takes effect was withheld for a missing quote.
test("an answer naming when the newer label takes effect passes the claim check", async () => {
  const section = sectionText("cardionex-uspi-v2", "2.2")!;
  const retrieved = [{ doc_id: section.docId, section: section.section, status: "active", text: section.text }];
  const check = claimCheckWith(modelClient());
  const answer = `Today's label applies: start at 20 mg once daily and raise to 40 mg once daily after 4 weeks [${section.docId}, ${section.section}]. The approved 2027 label is not in force yet; it takes effect March 1, 2027. Today's label took effect September 15, 2026.`;
  for (let run = 0; run < 2; run++) assert.deepEqual(await check(answer, retrieved, "Has the 2027 label changed the titration? What applies today?", "2026-11-23"), []);
});

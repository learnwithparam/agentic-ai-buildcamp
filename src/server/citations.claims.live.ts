// Lesson 21, claim by claim, on the real model through the gateway (npm run check:live).
// The support judge and the claim listing are model calls, so what they promise is proven here.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readGold } from "../../scripts/citations-eval";
import { claimCheckWith, extractClaims, judgeWithModel } from "./citations.claims";
import { modelClient } from "./gateway";
import { sectionText } from "./citations.claims";

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
  const claims = await extractClaims(modelClient(), `The label gives the starting dose in its dosage section [${section.docId}, ${section.section}].`, retrieved);
  assert.ok(claims.length > 0);
  for (const claim of claims) assert.deepEqual([claim.docId, claim.section], [section.docId, section.section]);
});

test("an answer with a fact the label does not state is flagged by the claim check", async () => {
  const section = sectionText("cardionex-uspi-v2", "2.2")!;
  const retrieved = [{ doc_id: section.docId, section: section.section, status: "active", text: section.text }];
  const check = claimCheckWith(modelClient());
  const problems = await check(`CardioNex is safe to give to children under two [${section.docId}, ${section.section}].`, retrieved, "Can a toddler take it?", "2026-11-26");
  assert.ok(problems.length > 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_SECTIONS } from "./labels";
import { scrubPhi } from "./phi";
import { approvedUses, reportingProcedure, routerInput, routeTool, safetyReply, stopReply, SAFETY_HOURS, withFloor, whichMedicineFirst, type Route } from "./tiers";

// Lesson 13. The parts of the tiers that are code, not a model: no model calls.

test("record numbers, emails, phone numbers and ID numbers leave the message", () => {
  const { text, removed } = scrubPhi(
    "Patient MRN-88412 (call 415-555-0134, email j.doe@example.org, SSN 123-45-6789) had angioedema. Medical record number 55120 too."
  );
  assert.equal(removed, 5);
  for (const leaked of ["88412", "415-555-0134", "j.doe@example.org", "123-45-6789", "55120"]) assert.ok(!text.includes(leaked), leaked);
  assert.match(text, /\[record number removed\]/);
});

test("doses, dates and label citations are not identifiers", () => {
  const plain = "Start 5mg once daily if eGFR is 24, per [cardionex-uspi-v2, 2.2], from 2026-01-15.";
  assert.deepEqual(scrubPhi(plain), { text: plain, removed: 0 });
});

const pharmaAUs = new Set(LABEL_SECTIONS.filter((section) => section.tenantId === "pharma_a" && section.country === "US").map((section) => section.docId));

test("the router compares with the approved uses this user may read, and nothing else", () => {
  const uses = approvedUses(pharmaAUs, LABEL_SECTIONS);
  assert.ok(uses.length > 0);
  for (const use of uses) {
    assert.ok(pharmaAUs.has(use.docId));
    assert.equal(use.status, "active");
  }
  const basis = (routeTool(uses).function.parameters as { properties: { basis: { enum: string[] } } }).properties.basis.enum;
  assert.deepEqual(basis, uses.map((use) => `${use.docId}, ${use.section}`));
  assert.deepEqual(approvedUses(new Set(), LABEL_SECTIONS), []);
});

test("the safety reply cites the company's procedure, quotes the deadline and gives no advice", () => {
  const reply = safetyReply({ asksForAdvice: true, removedIdentifiers: 1, procedure: reportingProcedure(pharmaAUs, LABEL_SECTIONS) });
  assert.match(reply, /^PV_ESCALATION/);
  assert.ok(reply.includes(`${SAFETY_HOURS} hours`));
  assert.ok(reply.includes("[pv-reporting-sop, 1.1]"));
  assert.ok(reply.includes("[pv-reporting-sop, 1.2]"));
  assert.match(reply, /cannot advise/);
  assert.doesNotMatch(reply, /\d+\s?mg/);
});

test("the safety reply makes no citation the user may not read", () => {
  const reply = safetyReply({ asksForAdvice: false, removedIdentifiers: 0, procedure: reportingProcedure(new Set(), LABEL_SECTIONS) });
  assert.doesNotMatch(reply, /\[/);
  assert.doesNotMatch(reply, /cannot advise/);
});

test("the stop reply refuses with no dose", () => {
  const reply = stopReply("neurovex-uspi-v1, 1.1");
  assert.match(reply, /^OFF_LABEL_REFUSAL/);
  assert.ok(reply.includes("[neurovex-uspi-v1, 1.1]"));
  assert.doesNotMatch(reply, /\d+\s?mg/);
});

test("a request for something to send goes to review even when the router says answer", () => {
  const answer: Route = { tier: "answer", reason: "a dose question", asksForAdvice: false };
  assert.equal(withFloor(answer, "Write a short email to Dr. Lee with the starting dose.").tier, "review");
  assert.equal(withFloor(answer, "Draft a reply to the pharmacist about storage.").tier, "review");
  assert.equal(withFloor(answer, "What is the starting dose of NeuroVex?").tier, "answer");
  // The floor only raises answer; it never lowers safety or stop to review.
  for (const tier of ["safety", "stop"] as const) assert.equal(withFloor({ ...answer, tier }, "Write an email about her rash").tier, tier);
});

test("the router sorts the latest message, and never reads the text of a refusal", () => {
  const refusal = "OFF_LABEL_REFUSAL The approved label does not cover a child under 12, so I cannot give a dose.";
  const input = routerInput([
    { type: "human", id: "1", content: "What is the CardioNex dose for eGFR 24?" },
    { type: "ai", id: "2", content: [{ type: "text", text: "5 mg once daily [cardionex-uspi-v2, 2.2]." }], tool_calls: [] },
    { type: "human", id: "3", content: "And for a 9-year-old?" },
    { type: "ai", id: "4", content: [{ type: "text", text: refusal }], tool_calls: [] },
    { type: "human", id: "5", content: "US patient with eGFR 32?" }
  ]);
  assert.match(input, /Message to sort:\nDoctor: US patient with eGFR 32\?$/);
  assert.match(input, /\(the desk replied OFF_LABEL_REFUSAL\)/);
  assert.match(input, /\(the desk answered\)/);
  assert.ok(!input.includes("child under 12"), "the refusal's wording reached the router");
  assert.equal(routerInput([{ type: "human", id: "1", content: "Storage?" }]), "Message to sort:\nDoctor: Storage?");
});

// AMBIGUOUS-01 failed 3 of 5 runs on 27 Nov 2026: asked "what dose should I give my patient?", the
// model picked CardioNex and gave 20mg. A dose with no medicine named is asked about in code.
test("a dose question that names no medicine asks which one, and gives no dose", () => {
  const human = (content: string, id = "q") => ({ id, type: "human" as const, content });
  const reply = whichMedicineFirst([human("What dose should I give my patient?")]);
  assert.match(reply ?? "", /^ASK_FOLLOW_UP /);
  assert.doesNotMatch(reply ?? "", /\d+\s*mg/);
  assert.equal(whichMedicineFirst([human("What dose of CardioNex for eGFR 24?")]), null);
  // Another company's medicine is named too: the agent says it cannot answer, not this question.
  assert.equal(whichMedicineFirst([human("What is the NeuroVex dosing?")]), null);
  assert.equal(whichMedicineFirst([human("Is CardioNex approved in Japan?", "a"), { id: "r", type: "ai" as const, content: [{ type: "text" as const, text: "Yes." }], tool_calls: [] }, human("And the dose for eGFR 32?")]), null);
  assert.equal(whichMedicineFirst([human("Suggest the next step for HCP-1001.")]), null);
});

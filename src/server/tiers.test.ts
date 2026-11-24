import assert from "node:assert/strict";
import { test } from "node:test";
import { LABEL_SECTIONS } from "./labels";
import { scrubPhi } from "./phi";
import { approvedUses, reportingProcedure, routeTool, safetyReply, stopReply, SAFETY_HOURS } from "./tiers";

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

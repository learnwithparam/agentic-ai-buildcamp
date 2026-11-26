import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LABEL_SECTIONS,
  approvalStatus,
  approvedCountries,
  checkInteraction,
  labelVersions,
  readSection,
  searchLabels,
  trialResults
} from "./labels";

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
  assert.deepEqual(approvedCountries("pharma_b"), ["JP", "US"]);
});

// Fix 0. The label lookups, on the real label files. The readable sets stand in for OpenFGA's
// can_read_abroad answer: every document of one company, in every country.
const companyDocs = (tenantId: string) => new Set(LABEL_SECTIONS.filter((s) => s.tenantId === tenantId).map((s) => s.docId));
const pharmaA = companyDocs("pharma_a");
const pharmaB = companyDocs("pharma_b");

test("label_versions says which US label is in force and why the others are not", () => {
  const versions = labelVersions("CardioNex", "US", pharmaA);
  const byId = Object.fromEntries(versions.map((v) => [v.docId, v]));
  assert.equal(byId["cardionex-uspi-v2"].status, "active");
  assert.match(byId["cardionex-uspi-v1"].reason, /^replaced by cardionex-uspi-v2 on \d{4}-\d{2}-\d{2}$/);
  assert.equal(byId["cardionex-uspi-v3"].reason, "approved, in force from 2027-03-01");
  assert.ok(versions.every((v) => !v.docId.includes("trial") && !v.docId.includes("faq")));
});

test("approval_status reads the use sections of the label in force in that country", () => {
  const japan = approvalStatus("CardioNex", "JP", pharmaA);
  assert.equal(japan.docId, "cardionex-jp-label");
  assert.ok(japan.uses.some((s) => s.section === "3.1" && /LVEF of 40% or lower/.test(s.text)));
  assert.equal(approvalStatus("NeuroVex", "JP", pharmaB).docId, "neurovex-jp-label");
  assert.equal(approvalStatus("NeuroVex", "DE", pharmaB).approved, false);
});

test("check_interaction finds the section that names the drug, and says when none does", () => {
  const spiro = checkInteraction("CardioNex", "spironolactone", "US", pharmaA);
  assert.equal(spiro.named, true);
  assert.ok(spiro.sections.some((s) => s.docId === "cardionex-uspi-v2" && s.section === "7.1"));
  const other = checkInteraction("CardioNex", "warfarin", "US", pharmaA);
  assert.equal(other.named, false);
  assert.ok(other.sections.length > 0 && other.sections.every((s) => s.section.startsWith("7.")));
});

test("trial_results quotes the trial sections about the outcome, only for the asker's company", () => {
  const potassium = trialResults("CardioNex", "potassium", pharmaA);
  assert.ok(potassium.some((s) => s.docId === "cardionex-clarion-hf-trial" && ["3.2", "3.4"].includes(s.section)));
  assert.deepEqual(trialResults("CardioNex", "potassium", pharmaB), []);
});

test("read_section returns full text only for a readable document", () => {
  assert.match(readSection("neurovex-uspi-v1", "2.3", pharmaB)?.text ?? "", /25mg twice daily/);
  assert.equal(readSection("neurovex-uspi-v1", "2.3", pharmaA), undefined);
});

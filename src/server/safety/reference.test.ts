import assert from "node:assert/strict";
import test from "node:test";
import { LABEL_SECTIONS } from "../labels";
import { labelLimits, limitsText } from "./reference";

const companyA = new Set(LABEL_SECTIONS.filter((section) => section.tenantId === "pharma_a").map((section) => section.docId));

test("the extraction checks against the label in force: its boxed warning, dosing and contraindications", () => {
  const sections = labelLimits(companyA, "US", "2026-11-23");
  const names = sections.map((section) => `${section.docId} ${section.section}`);
  assert.ok(names.includes("cardionex-uspi-v2 2.2"), "the renal dose table");
  assert.ok(names.includes("cardionex-uspi-v2 2.6"), "the ACE inhibitor washout");
  assert.ok(names.includes("cardionex-uspi-v2 4"), "the contraindications");
  assert.ok(names.includes("cardionex-uspi-v2 0.0"), "the boxed warning");
  assert.deepEqual([...new Set(sections.map((section) => section.docId))], ["cardionex-uspi-v2"], "one label: no old version, trial, FAQ or other country");
  assert.ok(!sections.some((section) => /^(5|6|7)/.test(section.section)), "only the limits, not the whole label");
  assert.match(limitsText(sections), /\[cardionex-uspi-v2 4 Contraindications\]/);
});

test("another company's labels are never in the check", () => {
  assert.ok(!labelLimits(companyA, "US", "2026-11-23").some((section) => section.tenantId !== "pharma_a"));
});

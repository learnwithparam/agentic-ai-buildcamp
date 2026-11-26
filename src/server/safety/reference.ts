import { inForceDocuments, LABEL_SECTIONS, type LabelSection } from "../labels";

// Two special situations depend on the label, not on the message: a dose above what the label
// allows for this patient (Wrong dose), and a medicine the label says must not be given with it or
// inside its washout (Exposure to contraindicated drug). A case processor checks a report against
// the company's reference safety information; the extraction gets the same sections to check with.
// Measured on 2026-11-26 before this: "an eGFR of 25 who was left on NeuroVex 50 mg twice daily"
// and "started on CardioNex 24 hours after his last lisinopril" were both coded with no situation.

// The prescribing label of each medicine (uspi, smpc, label), never a draft, a trial or the FAQ.
const PRESCRIBING = /(uspi|smpc|label)(-v\d+)?$/;
// The boxed warning, every dosing section, and the contraindications.
const LIMITS = (section: LabelSection) => section.section === "0.0" || section.section === "4" || /^2(\.|$)/.test(section.section);

export function labelLimits(readable: ReadonlySet<string>, country: string, today: string): LabelSection[] {
  const docs = inForceDocuments(new Set([...readable].filter((id) => PRESCRIBING.test(id))), today);
  return LABEL_SECTIONS.filter((section) => docs.has(section.docId) && section.country === country.toUpperCase() && LIMITS(section));
}

export function limitsText(sections: LabelSection[]): string {
  return sections.map((section) => `[${section.docId} ${section.section} ${section.title}]\n${section.text}`).join("\n\n");
}

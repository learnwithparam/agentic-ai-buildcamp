import type { SafetyCase, Seriousness } from "./extract";
import { dictionary } from "./meddra";

// A draft of the case in the shape of an ICH E2B(R3) individual case safety report (ICSR),
// built in code from the extraction. It is for a safety reviewer to check and to send; this
// file sends nothing and the XML says so.
//
// What "E2B(R3)-shaped" means here, said exactly: every data element below carries the number
// and name the ICH E2B(R3) Implementation Guide gives it (C.1.1, D.5, E.i.1.1a, G.k.1 and so on),
// in the order of the guide's sections. It is a flat <dataElement id=".." name=".."> layout, not
// the HL7 v3 message the regulators' gateways take, so it does not validate against that schema.
// A person turns it into the real message in the company's safety database.

// The data elements this draft uses, with the guide's names. A test fails if the XML uses an
// element that is not listed here, so a typo cannot reach a reviewer.
export const E2B_ELEMENTS = {
  "C.1.1": "Sender's (case) safety report unique identifier",
  "C.1.2": "Date of creation",
  "C.1.3": "Type of report",
  "C.1.4": "Date report was first received from source",
  "C.1.5": "Date of most recent information for this report version",
  "C.2.r.4": "Qualification",
  "D.1": "Patient (name or initials)",
  "D.2.2a": "Age at time of onset of reaction / event (number)",
  "D.2.2b": "Age at time of onset of reaction / event (unit)",
  "D.5": "Sex",
  "E.i.1.1a": "Reaction / event as reported by the primary source in native language",
  "E.i.2.1a": "MedDRA version for reaction / event",
  "E.i.2.1b": "MedDRA code for reaction / event",
  "E.i.3.2a": "Results in death",
  "E.i.3.2b": "Life threatening",
  "E.i.3.2c": "Caused / prolonged hospitalisation",
  "E.i.3.2d": "Disabling / incapacitating",
  "E.i.3.2e": "Congenital anomaly / birth defect",
  "E.i.3.2f": "Other medically important condition",
  "G.k.1": "Characterisation of drug role",
  "G.k.2.2": "Medicinal product name as reported by the primary source",
  "H.1": "Case narrative including clinical course, therapeutic measures, outcome and additional relevant information"
} as const;
export type ElementId = keyof typeof E2B_ELEMENTS;

const SERIOUS_ELEMENT: Record<Seriousness, ElementId> = {
  death: "E.i.3.2a",
  life_threatening: "E.i.3.2b",
  hospitalization: "E.i.3.2c",
  disability: "E.i.3.2d",
  congenital_anomaly: "E.i.3.2e",
  other_medically_important: "E.i.3.2f"
};

const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// C.2.r.4 values: 1 physician, 2 pharmacist, 3 other health professional, 4 lawyer, 5 consumer or other non health professional.
export function qualification(role: string | null): string | null {
  if (!role) return null;
  if (/\b(doctor|physician|gp|md|surgeon)\b/i.test(role)) return "1";
  if (/\bpharmacist\b/i.test(role)) return "2";
  if (/\b(nurse|midwife|dentist|health)\b/i.test(role)) return "3";
  if (/\blawyer\b/i.test(role)) return "4";
  if (/\b(patient|consumer|parent|relative|carer)\b/i.test(role)) return "5";
  return null;
}

// D.5: 1 male, 2 female.
const sexCode = (sex: string | null) => (!sex ? null : /^m/i.test(sex.trim()) ? "1" : /^f/i.test(sex.trim()) ? "2" : null);

// D.2.2a and D.2.2b: "70", "70 years" and "a man of 70" all give 70 years (unit 801). An age in other units is left out.
function ageOf(age: string | null): string | null {
  const match = age && /(\d{1,3})\s*(?:years?|yrs?|y\b|year old|$)/i.exec(age.trim());
  return match ? match[1]! : null;
}

export type DraftInput = {
  caseId: string;
  // When the desk first heard of the case (C.1.4). The same moment starts the 24 hour clock.
  receivedAt: Date;
  createdAt: Date;
  // The doctor's words, with identifiers already removed (src/server/phi.ts).
  narrative: string;
};

export type E2bDraft = { xml: string; elements: ElementId[]; missing: ElementId[] };

const stamp = (date: Date) => date.toISOString().replace(/[-:T]/g, "").slice(0, 14);

export function buildE2bDraft(safety: SafetyCase, input: DraftInput): E2bDraft {
  const used: ElementId[] = [];
  const missing: ElementId[] = [];
  const lines: string[] = [];
  const open = (tag: string, attrs: string, depth: number) => lines.push(`${"  ".repeat(depth)}<${tag}${attrs ? ` ${attrs}` : ""}>`);
  const close = (tag: string, depth: number) => lines.push(`${"  ".repeat(depth)}</${tag}>`);
  const element = (id: ElementId, value: string | null | undefined, depth: number) => {
    if (value === null || value === undefined || value === "") {
      missing.push(id);
      return;
    }
    used.push(id);
    lines.push(`${"  ".repeat(depth)}<dataElement id="${id}" name="${escape(E2B_ELEMENTS[id])}">${escape(value)}</dataElement>`);
  };

  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push("<!-- DRAFT. Built by code from what the doctor wrote. Not submitted to any authority. A safety reviewer checks every element and files the case in the safety database. -->");
  open("ichicsr", 'format="E2B(R3)-shaped" status="draft" submitted="false"', 0);
  open("safetyreport", "", 1);

  open("section", 'id="C.1" name="Identification of the case safety report"', 2);
  element("C.1.1", input.caseId, 3);
  element("C.1.2", stamp(input.createdAt), 3);
  element("C.1.3", "1", 3);
  element("C.1.4", stamp(input.receivedAt).slice(0, 8), 3);
  element("C.1.5", stamp(input.receivedAt).slice(0, 8), 3);
  close("section", 2);

  open("section", 'id="C.2" name="Primary source(s) of information"', 2);
  element("C.2.r.4", qualification(safety.extracted.reporter_role), 3);
  close("section", 2);

  const { patient } = safety.extracted;
  const age = ageOf(patient.age);
  open("section", 'id="D" name="Patient characteristics"', 2);
  element("D.1", patient.initials_or_label, 3);
  element("D.2.2a", age, 3);
  element("D.2.2b", age ? "801" : null, 3);
  element("D.5", sexCode(patient.sex), 3);
  close("section", 2);

  open("section", 'id="E.i" name="Reaction(s) / event(s)"', 2);
  if (!safety.events.length) missing.push("E.i.1.1a");
  safety.events.forEach((event, index) => {
    open("reaction", `n="${index + 1}"`, 3);
    element("E.i.1.1a", event.reportedTerm, 4);
    // A code is written only when the dictionary holds it; byLltCode throws on any other.
    const coded = event.coded ? dictionary().byLltCode(event.coded.llt.code) : null;
    element("E.i.2.1a", coded ? dictionary().version : null, 4);
    element("E.i.2.1b", coded?.llt.code ?? null, 4);
    for (const kind of safety.seriousness) element(SERIOUS_ELEMENT[kind], "true", 4);
    close("reaction", 3);
  });
  close("section", 2);

  open("section", 'id="G.k" name="Drug(s) information"', 2);
  open("drug", 'n="1"', 3);
  element("G.k.1", safety.extracted.product ? "1" : null, 4);
  element("G.k.2.2", safety.extracted.product, 4);
  close("drug", 3);
  close("section", 2);

  open("section", 'id="H" name="Narrative"', 2);
  element("H.1", input.narrative, 3);
  close("section", 2);

  close("safetyreport", 1);
  close("ichicsr", 0);
  return { xml: `${lines.join("\n")}\n`, elements: [...new Set(used)], missing: [...new Set(missing)] };
}

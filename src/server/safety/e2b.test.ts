import assert from "node:assert/strict";
import { test } from "node:test";
import { buildE2bDraft, E2B_ELEMENTS, qualification, type DraftInput } from "./e2b";
import { buildCase, criteriaOf, type Extracted } from "./extract";

// The E2B(R3)-shaped draft is built in code from the extraction. No model call.

const input: DraftInput = {
  caseId: "ae-thread-1",
  receivedAt: new Date("2026-11-20T10:00:00Z"),
  createdAt: new Date("2026-11-20T10:00:05Z"),
  narrative: "My patient, a man of 70, took CardioNex 20 mg and his lips swelled & he was admitted."
};

const full: Extracted = {
  reporter_role: "doctor",
  patient: { age: "70", sex: "male", initials_or_label: null },
  product: "CardioNex",
  events: [{ reported_term: "lips swelled", term: "Angioedema" }],
  special_situation: null,
  seriousness: ["hospitalization"]
};

const idsIn = (xml: string) => [...xml.matchAll(/<dataElement id="([^"]+)"/g)].map((match) => match[1]!);

test("a case with all four criteria carries every required element", () => {
  const draft = buildE2bDraft(buildCase(full), input);
  const ids = idsIn(draft.xml);
  for (const required of ["C.1.1", "C.1.2", "C.1.3", "C.1.4", "C.1.5", "C.2.r.4", "D.2.2a", "D.2.2b", "D.5", "E.i.1.1a", "E.i.2.1a", "E.i.2.1b", "E.i.3.2c", "G.k.1", "G.k.2.2", "H.1"]) {
    assert.ok(ids.includes(required), `${required} is missing`);
  }
  assert.deepEqual(draft.missing, ["D.1"], "the patient has no initials, and nothing else is missing");
  assert.match(draft.xml, /<dataElement id="E\.i\.2\.1b"[^>]*>92\d{6}<\/dataElement>/);
});

test("every element in the XML is one the E2B(R3) list names, with that name", () => {
  const xml = buildE2bDraft(buildCase(full), input).xml;
  for (const match of xml.matchAll(/<dataElement id="([^"]+)" name="([^"]+)"/g)) {
    const id = match[1] as keyof typeof E2B_ELEMENTS;
    assert.ok(id in E2B_ELEMENTS, `${id} is not a known element`);
    assert.equal(match[2], E2B_ELEMENTS[id]);
  }
});

test("the XML says it is a draft and never that it was submitted", () => {
  const xml = buildE2bDraft(buildCase(full), input).xml;
  assert.match(xml, /status="draft" submitted="false"/);
  assert.match(xml, /Not submitted/);
  assert.doesNotMatch(xml, /submitted="true"/);
});

test("the doctor's words are escaped, so they cannot add an element", () => {
  const xml = buildE2bDraft(buildCase(full), { ...input, narrative: '</dataElement><dataElement id="G.k.1">9' }).xml;
  assert.equal(idsIn(xml).filter((id) => id === "G.k.1").length, 1);
  assert.match(xml, /&lt;\/dataElement&gt;/);
});

test("a missing product, patient or event is listed, not invented", () => {
  const bare: Extracted = { ...full, product: null, patient: { age: null, sex: null, initials_or_label: null }, events: [], seriousness: [] };
  const safety = buildCase(bare);
  assert.deepEqual(safety.criteria, { reporter: true, patient: false, product: false, event: false });
  assert.deepEqual(safety.missing, ["patient", "product", "event"]);
  const draft = buildE2bDraft(safety, input);
  for (const absent of ["G.k.1", "G.k.2.2", "D.5", "D.2.2a", "E.i.1.1a"]) assert.ok(!idsIn(draft.xml).includes(absent), absent);
  assert.ok(draft.missing.includes("G.k.2.2") && draft.missing.includes("E.i.1.1a"));
});

test("a term the dictionary lacks keeps the reporter's words and gets no code", () => {
  const safety = buildCase({ ...full, events: [{ reported_term: "odd tingling in the toes", term: "Not a MedDRA term" }] });
  assert.equal(safety.events[0]!.coded, null);
  const xml = buildE2bDraft(safety, input).xml;
  assert.ok(idsIn(xml).includes("E.i.1.1a"));
  assert.ok(!idsIn(xml).includes("E.i.2.1b"));
});

test("each criterion is decided from the fields: any one patient identifier is enough", () => {
  assert.equal(criteriaOf({ ...full, patient: { age: null, sex: "female", initials_or_label: null } }).patient, true);
  assert.equal(criteriaOf({ ...full, patient: { age: " ", sex: null, initials_or_label: null } }).patient, false);
  assert.equal(criteriaOf({ ...full, reporter_role: null }).reporter, false);
  assert.equal(qualification("pharmacist"), "2");
  assert.equal(qualification("caller who is a doctor"), "1");
  assert.equal(qualification("somebody"), null);
});

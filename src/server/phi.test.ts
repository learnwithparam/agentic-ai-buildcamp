import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { PhiVault, findOnly, findSpans, leakedFrom, pseudonymise, scrubPhi, type PhiType } from "./phi";
import { measure, readNotes } from "../../scripts/phi-eval";

// Lesson 13. The pseudonymiser's rules and its vault: no model call. The model step is a function
// the tests pass in (a SpanFinder), so what it returns is known; what the real model returns is
// proven in phi.live.ts.

const types = (text: string) => findSpans(text).map((span) => span.type);
const words = (text: string, type: PhiType) => findSpans(text).filter((span) => span.type === type).map((span) => span.text);

test("a name after a title, a cue or beside another identifier is found, and the title stays", () => {
  assert.deepEqual(words("Mrs Hanna Keller had potassium 6.1.", "name"), ["Hanna Keller"]);
  assert.deepEqual(words("My patient Tomas Alvarez fainted.", "name"), ["Tomas Alvarez"]);
  assert.deepEqual(words("Her husband Venkat Narayanan phoned.", "name"), ["Venkat Narayanan"]);
  assert.deepEqual(words("She gave her name as Mei-Ling Chow.", "name"), ["Mei-Ling Chow"]);
  assert.deepEqual(words("Patient J. K. Okonkwo-Reid, MRN 00-7731-92, is sleepy.", "name"), ["J. K. Okonkwo-Reid"]);
  assert.deepEqual(words("Initials R.T., male, 62.", "name"), ["R.T."]);
  assert.deepEqual(words("Kwame Mensah, 14/03/1951, overdosed.", "name"), ["Kwame Mensah"]);
  assert.deepEqual(words("Mr Pieter van der Berg, DOB 1955-02-17, has a cough.", "name"), ["Pieter van der Berg"]);
});

test("dates of birth in each written form, with a cue or beside another identifier", () => {
  for (const date of ["14/03/1951", "1962-08-30", "14.03.1951", "March 14, 1951", "5 June 1944", "1958年3月14日"]) {
    assert.deepEqual(words(`Patient born ${date} has a cough.`, "dob"), [date], date);
  }
  assert.deepEqual(words("DOB 03-14-51, on CardioNex.", "dob"), ["03-14-51"]);
  assert.deepEqual(words("Olga Petrova (1948-09-03) was given 40 mg.", "dob"), ["1948-09-03"]);
});

test("addresses need a house number and a postcode; a clinic's street alone is left", () => {
  assert.deepEqual(words("She lives at 221 Maple Street, Springfield, IL 62704. What do I tell her?", "address"), ["221 Maple Street, Springfield, IL 62704"]);
  assert.deepEqual(words("wohnhaft Lindenstraße 12, 10969 Berlin, hat Schwellungen", "address"), ["Lindenstraße 12, 10969 Berlin"]);
  assert.deepEqual(words("Her home is Flat 2B, 8 Canal Street, Manchester M1 3HE.", "address"), ["Flat 2B, 8 Canal Street, Manchester M1 3HE"]);
  assert.deepEqual(words("He lives at 東京都新宿区西新宿2-8-1.", "address"), ["東京都新宿区西新宿2-8-1"]);
  assert.deepEqual(words("I am at the Lakeside Heart Clinic, 4 Water Lane.", "address"), []);
  assert.deepEqual(words("Send it to the Lakeside Heart Clinic, Leeds LS6 2QW.", "address"), []);
});

test("record numbers, phones, emails and ID numbers, in the shapes of several countries", () => {
  for (const mrn of ["A-448210", "00-7731-92", "C 55-1920", "4471-B"]) assert.deepEqual(words(`MRN ${mrn}, on NeuroVex.`, "mrn"), [mrn], mrn);
  assert.deepEqual(words("Patientennummer P-2031-88, nimmt NeuroVex.", "mrn"), ["P-2031-88"]);
  assert.deepEqual(words("On 14 Mar 1951, HV-2209, started.", "mrn"), ["HV-2209"]);
  for (const phone of ["(415) 555-0132", "+49 30 5550142", "+33 1 55 50 01 42", "03-5550-1234", "+44 20 7946 0123"]) {
    assert.deepEqual(words(`Call me on ${phone} please.`, "phone"), [phone], phone);
  }
  assert.deepEqual(words("Her email is c.mendoza@example.com.", "email"), ["c.mendoza@example.com"]);
  for (const id of ["078-05-1120", "A123456789", "6605195009087", "12 345 678 901"]) assert.deepEqual(words(`national ID ${id}, admitted.`, "national_id"), [id], id);
});

test("an email that starts with the sender's own surname is the sender's, not a patient's", () => {
  assert.deepEqual(words("I'm Dr Chen, chen.family@example.net. My patient David Chen-Park (david.chenpark@example.org).", "email"), ["david.chenpark@example.org"]);
});

test("doses, lab values, trial figures, label references and dates of events are not identifiers", () => {
  const clinical = [
    "Start 5mg once daily if eGFR is 24, per [cardionex-uspi-v2, 2.2], from 2026-01-15.",
    "Her eGFR 32 and K 6.1 mmol/L; BP 84/50 on CardioNex 20 mg twice daily.",
    "CLARION-HF enrolled 2,410 patients; 14% were 75 or older; the limit is 5.5 mEq/L (section 5.1).",
    "He started CardioNex on 12 March 2026 and was admitted 14/11/2026. Since 3 Nov a rash. Lot 24K118 crumbled.",
    "She started it on 12 March 2023 and stopped it on 2024-02-01; the last dose was before 03/05/2022.",
    "Child-Pugh B with an INR of 1.6 and a creatinine clearance of 45 mL/min. Wait 36 hours after the ACE inhibitor.",
    "Born in 1948, lives alone. A 59 year old patient of Dr Ng at Westfield Medical Group had it last year.",
    "The pharmacist Li Na called it in. The pharmacy at Sakae Hospital wants the Japanese insert."
  ];
  for (const text of clinical) assert.deepEqual(findSpans(text), [], text);
});

test("the same identifier gets the same placeholder in every turn, and a new one gets the next number", async () => {
  const vault = new PhiVault();
  const first = await pseudonymise("My patient Hanna Keller (DOB 14/03/1951), MRN A-448210, called (415) 555-0132.", vault);
  assert.equal(first.text, "My patient [PATIENT_1] (DOB [DOB_1]), MRN [MRN_1], called [PHONE_1].");
  const second = await pseudonymise("Keller is better. Her number (415) 555-0132 is the same. The other patient is Mrs Rosa Delgado, DOB 1950-02-02.", vault);
  assert.equal(second.text, "[PATIENT_1] is better. Her number [PHONE_1] is the same. The other patient is Mrs [PATIENT_2], DOB [DOB_2].");
  assert.equal(await pseudonymise("Hanna Keller again", vault).then((r) => r.text), "[PATIENT_1] again");
  // A later turn names the patient by surname behind a cue the rules know: still the same placeholder.
  assert.equal(await pseudonymise("My patient Keller is better.", vault).then((r) => r.text), "My patient [PATIENT_1] is better.");
  assert.equal(vault.placeholderFor("name", "hanna   KELLER"), "[PATIENT_1]");
  assert.equal(vault.placeholderFor("dob", "14/03/1951"), "[DOB_1]");
});

test("restore puts the doctor's own words back, and leaves a placeholder it does not know", async () => {
  const vault = new PhiVault();
  const { text } = await pseudonymise("Patient Hanna Keller, MRN A-448210, has swollen lips.", vault);
  assert.equal(vault.restore(`Please report ${text.match(/\[PATIENT_1\]/)![0]} and [MRN_1]; see [PATIENT_9].`), "Please report Hanna Keller and A-448210; see [PATIENT_9].");
  assert.deepEqual(vault.restoreDeep({ a: ["[MRN_1]", { b: "x [PATIENT_1]" }], n: 3 }), { a: ["A-448210", { b: "x Hanna Keller" }], n: 3 });
});

test("the vault is per conversation: another vault starts again at 1", async () => {
  const a = new PhiVault();
  const b = new PhiVault();
  assert.equal((await pseudonymise("Mrs Hanna Keller", a)).text, "Mrs [PATIENT_1]");
  assert.equal((await pseudonymise("Mrs Rosa Delgado", b)).text, "Mrs [PATIENT_1]");
  assert.equal(b.restore("[PATIENT_1]"), "Rosa Delgado");
});

test("the model's words count only when they are in the text, and never a placeholder or the whole message", () => {
  const text = "The neighbour Zelda Quimby and [PATIENT_1] came. Zelda Quimby left.";
  const found = findOnly(text, [
    { text: "Zelda Quimby", type: "name" },
    { text: "Nobody Atall", type: "name" },
    { text: "[PATIENT_1]", type: "name" },
    { text: text, type: "name" },
    { text: "x", type: "name" }
  ]);
  assert.deepEqual(found.map((span) => [span.start, span.text]), [[14, "Zelda Quimby"], [text.lastIndexOf("Zelda"), "Zelda Quimby"]]);
});

test("the model step sees only what the rules left, and what it finds is replaced", async () => {
  const vault = new PhiVault();
  let seen = "";
  const out = await pseudonymise("Mrs Hanna Keller, DOB 14/03/1951, was driven by the neighbour Zelda Quimby to hospital.", vault, async (scrubbed) => {
    seen = scrubbed;
    return [{ text: "Zelda Quimby", type: "name" }];
  });
  assert.equal(seen, "Mrs [PATIENT_1], DOB [DOB_1], was driven by the neighbour Zelda Quimby to hospital.");
  assert.equal(out.text, "Mrs [PATIENT_1], DOB [DOB_1], was driven by the neighbour [PATIENT_2] to hospital.");
  assert.equal(vault.restore(out.text), "Mrs Hanna Keller, DOB 14/03/1951, was driven by the neighbour Zelda Quimby to hospital.");
});

test("a short message skips the model step", async () => {
  await pseudonymise("What is 5.1?", new PhiVault(), async () => {
    throw new Error("the finder should not have been called");
  });
});

test("the leak check finds an original in any payload, and nothing else", async () => {
  const vault = new PhiVault();
  const { text } = await pseudonymise("Mrs Hanna Keller, MRN A-448210.", vault);
  assert.deepEqual(leakedFrom(vault, [text, JSON.stringify({ messages: [text] })]), []);
  assert.deepEqual(leakedFrom(vault, [text, "the checkpoint holds A-448210"]), ["A-448210"]);
});

test("the older call sites keep their labels, and now remove names, dates and addresses too", () => {
  const { text, removed } = scrubPhi("Mrs Hanna Keller, DOB 14/03/1951, MRN A-448210, lives at 221 Maple Street, Springfield, IL 62704.");
  assert.equal(removed, 4);
  assert.equal(text, "Mrs [name removed], DOB [date of birth removed], MRN [record number removed], lives at [address removed].");
});

// Holdout: wordings the rules were not written against.
test("notes written after the rules, in new wordings", () => {
  const hidden = (text: string) => scrubPhi(text).text;
  const out = hidden("Patient Maria Gonzalez, born 3 July 1948, MRN 99-1234, lives at 12 High Street, Bristol BS1 4DJ, called me on 0117 496 0123. eGFR 32, K 5.4.");
  for (const leaked of ["Maria", "Gonzalez", "3 July 1948", "99-1234", "High Street", "BS1 4DJ", "0117 496 0123"]) assert.ok(!out.includes(leaked), `${leaked} in: ${out}`);
  assert.match(out, /eGFR 32, K 5\.4\./);
  assert.ok(!hidden("Herr Müller, geboren am 05.06.1950, wohnt in der Hauptstraße 3, 80331 München.").match(/05\.06\.1950|80331|Müller/));
  assert.ok(!hidden("Tom Baker, 1962-08-30, took 3 tablets.").match(/Baker|1962/));
  assert.ok(!hidden("Her daughter Sarah Collins phoned on +44 7700 900123.").match(/Collins|7700/));
  assert.equal(hidden("Ms. Priya Nair (DOB: 01/02/1975) took CardioNex 40 mg since 2026-01-15. Potassium 6.1 mmol/L on 3 Nov 2026."), "Ms. [name removed] (DOB: [date of birth removed]) took CardioNex 40 mg since 2026-01-15. Potassium 6.1 mmol/L on 3 Nov 2026.");
});

test("on the 100 marked notes the rules alone reach the bar: recall 0.99, 0.05 false positives a note, no leak", async () => {
  const { scores } = await measure(readNotes());
  assert.ok(scores.recall >= 0.99, `recall ${scores.recall}`);
  assert.ok(scores.false_positives_per_note <= 0.05, `false positives ${scores.false_positives_per_note}`);
  assert.equal(scores.output_leaks, 0);
});

test("the notes file is the pinned dataset copy, with its gold spans where the text says", () => {
  for (const note of readNotes()) for (const span of note.spans) assert.equal(note.text.slice(span.start, span.end), span.text, note.id);
  assert.ok(readFileSync(new URL("../../data/hcp/safety/phi-notes.jsonl", import.meta.url), "utf8").length > 0);
});

// Measured on 2026-11-26: the sweep's picker was sent "[record number removed]" for HCP-1001, so it
// planned no doctor. HCP-1234 is the desk's own id for a doctor in its CRM, never a patient's.
test("a doctor's CRM id is the desk's own, not a patient's record number", () => {
  assert.equal(scrubPhi("Clear the pending sample requests for HCP-1001 and HCP-1004.").text, "Clear the pending sample requests for HCP-1001 and HCP-1004.");
  assert.equal(scrubPhi("Follow up with HCP-1001 on MRN-77310.").text, "Follow up with HCP-1001 on [record number removed].");
});

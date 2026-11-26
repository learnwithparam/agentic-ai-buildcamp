import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { measure, oracle, readNotes, runFile, score, stillThere, type Note, type NoteResult } from "./phi-eval";

// Lesson 13. The arithmetic of npm run phi:measure, with no model: the notes are small, the
// answers are worked out by hand, and the stand-in for the model is a function that returns gold spans.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const gold = (text: string, word: string, type: Note["spans"][number]["type"]) => ({ start: text.indexOf(word), end: text.indexOf(word) + word.length, type, text: word });

const t1 = "Mrs Ann Lee, DOB 01/02/1950, has a cough on CardioNex 20 mg.";
const t2 = "The neighbour Zed Quill drove my patient to hospital with eGFR 32.";
const t3 = "What does section 5.1 say about CLARION-HF? No patient.";
const NOTES: Note[] = [
  { id: "n1", text: t1, spans: [gold(t1, "Ann Lee", "name"), gold(t1, "01/02/1950", "dob")] },
  { id: "n2", text: t2, spans: [gold(t2, "Zed Quill", "name")] },
  { id: "n3", text: t3, spans: [] }
];

test("rules alone: two of three spans hidden, no false positive", async () => {
  const { scores, misses } = await measure(NOTES);
  assert.equal(scores.recall, 0.667);
  assert.deepEqual(scores.recall_by_type, { name: 0.5, dob: 1 });
  assert.equal(scores.false_positives_per_note, 0);
  assert.equal(scores.output_leaks, 0);
  assert.deepEqual(misses, [{ id: "n2", type: "name", text: "Zed Quill" }]);
});

test("rules and a finder that names the missed span: all three hidden", async () => {
  const { scores, misses } = await measure(NOTES, oracle);
  assert.equal(scores.recall, 1);
  assert.deepEqual(misses, []);
});

test("a replaced word that is no gold span is a false positive, counted per note", async () => {
  const wrong = async () => [{ text: "hospital", type: "address" as const }, { text: "Zed Quill", type: "name" as const }];
  const { scores, false_positives } = await measure(NOTES, () => wrong);
  assert.deepEqual(false_positives, [{ id: "n2", type: "address", text: "hospital" }]);
  assert.equal(scores.false_positives_per_note, 0.333);
});

test("score() arithmetic: recall by span and by type, false positives per note, leaks added up", () => {
  const results: NoteResult[] = [
    { id: "a", hidden: [{ type: "name", text: "x", hidden: true }, { type: "name", text: "y", hidden: false }, { type: "dob", text: "z", hidden: true }], falsePositives: [{ type: "name", text: "q" }], leaks: [] },
    { id: "b", hidden: [{ type: "phone", text: "p", hidden: true }], falsePositives: [], leaks: ["p", "r"] },
    { id: "c", hidden: [], falsePositives: [{ type: "name", text: "s" }, { type: "dob", text: "t" }], leaks: [] },
    { id: "d", hidden: [], falsePositives: [], leaks: [] }
  ];
  assert.deepEqual(score(results), { recall: 0.75, recall_by_type: { name: 0.5, dob: 1, phone: 1 }, false_positives_per_note: 0.75, output_leaks: 2 });
  assert.equal(score([]).recall, 1);
});

test("a gold span is still there when its words or any long word in it remain; a title is not part of a name", () => {
  assert.equal(stillThere("Ms Eleni Papadakis", "Practice: Papadakis Medical"), true);
  assert.equal(stillThere("Ms Eleni Papadakis", "Ms [PATIENT_1] came"), false);
  assert.equal(stillThere("Mrs Ann Lee", "Mrs came"), false);
  assert.equal(stillThere("A. B.", "Patient [PATIENT_1] (female)"), false);
  assert.equal(stillThere("A. B.", "Patient A. B. (female)"), true);
  assert.equal(stillThere("(510) 555-0162", "call [PHONE_1] or 510"), true);
});

test("the pinned notes load, and --fake runs offline, with an oracle, and writes only where --out says", () => {
  assert.equal(readNotes().length, 100);
  const dir = mkdtempSync(path.join(tmpdir(), "phi-eval-"));
  const out = path.join(dir, "phi.json");
  const printed = execFileSync("npx", ["tsx", "scripts/phi-eval.ts", "--fake", "--out", out], { cwd: ROOT, encoding: "utf8", env: { ...process.env, GATEWAY_KEY_EVAL_RUNNER: "", GATEWAY_KEY_MEDINFO_APP: "" } });
  assert.match(printed, /^rules {8}/m);
  assert.match(printed, /^rules_model /m);
  const run = JSON.parse(readFileSync(out, "utf8")) as { measures: Record<string, number>; notes: number; spans: number; model: string; configs: Record<string, { recall: number }> };
  assert.deepEqual(run.measures, { "phi.recall": 1, "phi.false_positives_per_note": 0, "phi.output_leaks": 0 });
  assert.equal(run.notes, 100);
  assert.equal(run.spans, 201);
  assert.equal(run.model, "oracle (--fake)");
  assert.ok(run.configs.rules!.recall >= 0.99);
});

test("a --fake run writes no file unless --out names one; a real run writes docs/runs/phi.json", () => {
  assert.equal(runFile(true), undefined);
  assert.equal(runFile(true, "somewhere.json"), "somewhere.json");
  assert.equal(runFile(false), path.join(ROOT, "docs/runs/phi.json"));
});

// Lesson 13. npm run phi:measure: how well the pseudonymiser (src/server/phi.ts) hides patient
// identifiers, on the hand-marked notes in data/hcp/safety/phi-notes.jsonl.
//
// Each note has the identifiers in it marked by hand (gold spans: where, which type). The script
// runs every note two ways, so the page can show what the model step is worth:
//   rules         shapes, dates near "born", addresses with a postcode, names near a cue
//   rules_model   the rules, then one model call for the names and addresses they missed
//
// The measures (written to docs/runs/phi.json, compared by docs/measures.md), for rules_model:
//   recall                    gold spans no longer in the text the model reads, over all gold spans
//   false_positives_per_note  things replaced that are not a gold span, per note
//   output_leaks              identifiers the pseudonymiser replaced that are still in the text sent
//                             to the model, the trace input or the checkpoint's bytes
// A gold span is hidden when the span's words, and each longer word in it, are gone from the text.
// A title in front of a name ("Mrs") is not part of the name.
//
//   npm run phi:measure                real model, through the gateway, writes docs/runs/phi.json
//   npm run phi:measure -- --fake      no model: an oracle gives back each note's gold spans, so the
//                                      run proves the arithmetic. Writes no file unless --out is given.
import "../src/server/load-env";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main";
import { MemorySaver } from "@langchain/langgraph";
import { PHI_TYPES, PhiVault, leakedFrom, pseudonymise, type PhiType, type SpanFinder } from "../src/server/phi";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type GoldSpan = { start: number; end: number; type: PhiType; text: string };
export type Note = { id: string; text: string; spans: GoldSpan[] };
export type NoteResult = {
  id: string;
  hidden: Array<{ type: PhiType; text: string; hidden: boolean }>;
  falsePositives: Array<{ type: PhiType; text: string }>;
  leaks: string[];
};

const TITLES = /^(?:Mr|Mrs|Ms|Miss|Mme|Mlle|Mx|Herr|Frau|Madame|Monsieur)\.?\s+/;
const round = (value: number) => Math.round(value * 1000) / 1000;

export function readNotes(file = path.join(root, "data/hcp/safety/phi-notes.jsonl")): Note[] {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Note);
}

const bare = (span: string) => span.replace(TITLES, "");

// A gold span is still in the text when its words are, or any word in it that is long enough to
// stand for it: four letters, or three characters with a digit.
export function stillThere(span: string, output: string): boolean {
  const words = bare(span).trim();
  if (output.includes(words)) return true;
  return words
    .split(/[\s,()]+/)
    .map((word) => word.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter((word) => word.length >= 4 || (word.length >= 3 && /\d/.test(word)))
    .some((word) => output.includes(word));
}

// What found text counts as a false positive: it shares no words with any gold span of the note.
function isMarked(found: string, gold: GoldSpan[]): boolean {
  const a = bare(found).toLowerCase();
  return gold.some((span) => {
    const b = bare(span.text).toLowerCase();
    return a.includes(b) || b.includes(a);
  });
}

// The bytes the checkpointer would write for this thread's messages.
async function checkpointBytes(messages: unknown): Promise<string> {
  const [, bytes] = await new MemorySaver().serde.dumpsTyped({ messages });
  return Buffer.from(bytes).toString("utf8");
}

export async function runNote(note: Note, find?: SpanFinder): Promise<NoteResult> {
  const vault = new PhiVault();
  const result = await pseudonymise(note.text, vault, find);
  const messages = [{ id: note.id, type: "human", content: result.text }];
  const payloads = [result.text, JSON.stringify({ threadId: note.id, messages }), await checkpointBytes(messages)];
  return {
    id: note.id,
    hidden: note.spans.map((span) => ({ type: span.type, text: span.text, hidden: !stillThere(span.text, result.text) })),
    falsePositives: result.found.filter((item) => !isMarked(item.text, note.spans)),
    leaks: leakedFrom(vault, payloads)
  };
}

export type Scores = {
  recall: number;
  recall_by_type: Partial<Record<PhiType, number>>;
  false_positives_per_note: number;
  output_leaks: number;
};

export function score(results: NoteResult[]): Scores {
  const all = results.flatMap((result) => result.hidden);
  const recallOf = (items: typeof all) => (items.length ? round(items.filter((item) => item.hidden).length / items.length) : 1);
  const byType: Scores["recall_by_type"] = {};
  for (const type of PHI_TYPES) {
    const items = all.filter((item) => item.type === type);
    if (items.length) byType[type] = recallOf(items);
  }
  return {
    recall: recallOf(all),
    recall_by_type: byType,
    false_positives_per_note: results.length ? round(results.reduce((sum, result) => sum + result.falsePositives.length, 0) / results.length) : 0,
    output_leaks: results.reduce((sum, result) => sum + result.leaks.length, 0)
  };
}

// One config over every note. finderFor gives the model step for a note, or none for rules alone.
export async function measure(notes: Note[], finderFor?: (note: Note) => SpanFinder) {
  const results: NoteResult[] = [];
  for (const note of notes) results.push(await runNote(note, finderFor?.(note)));
  const misses = results.flatMap((result) => result.hidden.filter((item) => !item.hidden).map((item) => ({ id: result.id, type: item.type, text: item.text })));
  const falsePositives = results.flatMap((result) => result.falsePositives.map((item) => ({ id: result.id, ...item })));
  return { scores: score(results), misses, false_positives: falsePositives, leaks: results.flatMap((result) => result.leaks.map((leak) => ({ id: result.id, leak }))) };
}

// The stand-in for the model in --fake runs: it names every gold span of the note, so what the
// rules missed is found and nothing else is. It is a function, not a model client.
export const oracle =
  (note: Note): SpanFinder =>
  async () =>
    note.spans.map((span) => ({ text: span.text, type: span.type }));

// Where the run is written: a --fake run (an oracle, not a model) writes nowhere unless told to, so it can never become the measured file.
export function runFile(offline: boolean, out?: string): string | undefined {
  return out ?? (offline ? undefined : path.join(root, "docs/runs/phi.json"));
}

function option(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function main() {
  const offline = process.argv.includes("--fake");
  const notes = readNotes(option("--notes"));
  let finderFor: (note: Note) => SpanFinder;
  if (offline) {
    finderFor = oracle;
  } else {
    const { useService } = await import("../src/server/gateway");
    const { modelSpanFinder } = await import("../src/server/phi.model");
    useService("eval-runner");
    const finder = modelSpanFinder();
    finderFor = () => finder;
  }
  const rules = await measure(notes);
  const withModel = await measure(notes, finderFor);
  const out = runFile(offline, option("--out"));
  const run = {
    measures: {
      "phi.recall": withModel.scores.recall,
      "phi.false_positives_per_note": withModel.scores.false_positives_per_note,
      "phi.output_leaks": withModel.scores.output_leaks
    },
    commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
    at: new Date().toISOString(),
    notes: notes.length,
    spans: notes.reduce((sum, note) => sum + note.spans.length, 0),
    model: offline ? "oracle (--fake)" : "gateway",
    configs: { rules: rules.scores, rules_model: withModel.scores },
    misses: { rules: rules.misses, rules_model: withModel.misses },
    false_positives: { rules: rules.false_positives, rules_model: withModel.false_positives },
    leaks: { rules: rules.leaks, rules_model: withModel.leaks }
  };
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  }
  for (const [name, scores] of Object.entries(run.configs)) console.log(name.padEnd(12), JSON.stringify(scores));
  console.log(`${rules.misses.length} spans missed by the rules, ${withModel.misses.length} after the model step.`);
  console.log(out ? `Wrote ${path.relative(root, out)}.` : "Wrote no file (--fake without --out).");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runMain(main, { name: "PHI measure" });

/**
 * The rubric judge's calibration set: candidate answers built from the dataset, two people's
 * labels on them, and the agreement arithmetic.
 *
 *   npm run evals:candidates          writes data/calibration/rubric-labels.tsv, keeping every label already in it
 *   npm run evals:candidates -- --check   no write: says how many rows are labelled and whether the labellers agree
 *
 * Each candidate is one answer to one case, with the criterion the judge applies to it: the case's
 * llm-rubric asserts, or, for a case without one, "say what the ideal answer says". The answer is the
 * case's ideal answer or a copy changed by one rule below. The script labels nothing: two people
 * fill the labeller_a and labeller_b columns with pass or fail, without opening the `edit` column,
 * which says how the answer was made.
 *
 * Arithmetic (the same Cohen's kappa as scripts/judge/faithfulness.ts):
 *   labeller kappa     the two labellers against each other, over every row both labelled
 *   consensus          the rows where both labellers gave the same label
 *   judge agreement    the share of consensus rows where the judge's verdict equals the label
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllCases, type CaseItem } from "./hcp-cases";
import { cohenKappa, KAPPA_BAR, type Pair } from "./judge/faithfulness";

export const LABELS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../data/calibration/rubric-labels.tsv");
export const TARGET_ITEMS = 60;
export const AGREEMENT_BAR = 0.85;

export type EditKind = "ideal" | "number" | "flip" | "refusal" | "cut";
const KIND_RANK: EditKind[] = ["ideal", "number", "flip", "refusal", "cut"];

export type Candidate = { id: string; caseId: string; slice: string; criterion: string; question: string; answer: string; edit: EditKind };
export type Label = "pass" | "fail" | "";
export type LabelRow = Candidate & { labellerA: Label; labellerB: Label };

const REFUSAL = "INSUFFICIENT_CONTEXT I cannot answer that from the labels.";

// A number that is not inside a [doc, section] bracket, made different: an integer doubles, a decimal gains 1 before the point.
export function changeFirstNumber(text: string): string | null {
  const parts = text.split(/(\[[^\]]*\])/);
  for (let i = 0; i < parts.length; i += 2) {
    const match = /\d+(?:\.\d+)?/.exec(parts[i]!);
    if (!match) continue;
    const value = match[0];
    const changed = value.includes(".") ? `${Number(value.split(".")[0]) + 1}.${value.split(".")[1]}` : String(Number(value) === 0 ? 1 : Number(value) * 2);
    parts[i] = parts[i]!.slice(0, match.index) + changed + parts[i]!.slice(match.index + value.length);
    return parts.join("");
  }
  return null;
}

// The opposite verdict: a leading No becomes Yes and the other way round.
export function flipVerdict(text: string): string | null {
  if (/^No\b/.test(text)) return text.replace(/^No\b/, "Yes");
  if (/^Yes\b/.test(text)) return text.replace(/^Yes\b/, "No");
  return null;
}

// The first sentence alone, when there are two or more.
export function firstSentence(text: string): string | null {
  const sentences = text.match(/[^.!?]+(?:[.!?]+(?=\s|$)|$)/g)?.map((s) => s.trim()).filter(Boolean) ?? [];
  return sentences.length >= 2 ? sentences[0]! : null;
}

export function criterionOf(item: CaseItem): string {
  return item.expectedOutput.rubrics.length
    ? item.expectedOutput.rubrics.join("\n")
    : `Says what this reference answer says, with the same doses, numbers, dates and decision: ${item.expectedOutput.idealAnswer}`;
}

export function candidatesFor(item: CaseItem): Candidate[] {
  const ideal = item.expectedOutput.idealAnswer;
  if (!ideal) return [];
  const edits: Array<[EditKind, string | null]> = [
    ["ideal", ideal],
    ["number", changeFirstNumber(ideal)],
    ["flip", flipVerdict(ideal)],
    ["refusal", item.expectedOutput.expectedBehavior === "reply" ? REFUSAL : null],
    ["cut", firstSentence(ideal)]
  ];
  return edits.flatMap(([edit, answer]) =>
    answer === null
      ? []
      : [{
          id: `${item.metadata.caseId.toLowerCase()}-${edit}`,
          caseId: item.metadata.caseId,
          slice: item.metadata.slice,
          criterion: criterionOf(item),
          question: item.input.messages.map((m) => `${m.role}: ${m.content}`).join(" / "),
          answer,
          edit
        }]
  );
}

// Every candidate of a case with an llm-rubric first (the judge exists for them). Then one candidate
// per other case, in case id order, alternating the case's ideal answer with its first edited
// copy, so the set holds about as many answers that should pass as answers that should fail.
// Then whatever is left, in a fixed order, until TARGET_ITEMS. A rule, not a hand pick: the same input gives the same list.
export function buildCandidates(items: CaseItem[], limit = TARGET_ITEMS): Candidate[] {
  const byKind = (a: Candidate, b: Candidate) => KIND_RANK.indexOf(a.edit) - KIND_RANK.indexOf(b.edit);
  const ordered = [...items].sort((a, b) => a.metadata.caseId.localeCompare(b.metadata.caseId));
  const first = ordered.filter((item) => item.expectedOutput.rubrics.length).flatMap((item) => candidatesFor(item).sort(byKind));
  const rest = ordered.filter((item) => !item.expectedOutput.rubrics.length).map((item) => candidatesFor(item).sort(byKind));
  const alternated = rest.flatMap((list, index) => (list.length ? [index % 2 === 0 ? list[0]! : (list[1] ?? list[0]!)] : []));
  const used = new Set([...first, ...alternated].map((c) => c.id));
  const leftover = rest.flat().filter((c) => !used.has(c.id)).sort((a, b) => byKind(a, b) || a.caseId.localeCompare(b.caseId));
  return [...first, ...alternated, ...leftover].slice(0, limit);
}

// --- The file: tab separated, one header row, one line per candidate.

const COLUMNS = ["id", "case", "slice", "question", "criterion", "answer", "labeller_a", "labeller_b", "edit"] as const;
const clean = (text: string) => text.replace(/[\t\r\n]+/g, " ⏎ ");
const restore = (text: string) => text.replaceAll(" ⏎ ", "\n");

export function formatLabels(rows: LabelRow[]): string {
  const lines = rows.map((r) => [r.id, r.caseId, r.slice, r.question, r.criterion, r.answer, r.labellerA, r.labellerB, r.edit].map(clean).join("\t"));
  return `${COLUMNS.join("\t")}\n${lines.join("\n")}\n`;
}

const asLabel = (value: string | undefined): Label => {
  const v = (value ?? "").trim().toLowerCase();
  if (["pass", "1", "true", "yes"].includes(v)) return "pass";
  if (["fail", "0", "false", "no"].includes(v)) return "fail";
  if (v === "") return "";
  throw new Error(`A label must be pass or fail, got "${value}".`);
};

export function parseLabels(text: string): LabelRow[] {
  const [header, ...lines] = text.split("\n").filter((line) => line.trim());
  if (!header || header.split("\t").join(",") !== COLUMNS.join(",")) throw new Error(`The labels file must start with: ${COLUMNS.join(", ")} (tab separated).`);
  return lines.map((line) => {
    const cells = line.split("\t").map(restore);
    if (cells.length !== COLUMNS.length) throw new Error(`A row has ${cells.length} columns, not ${COLUMNS.length}: ${line.slice(0, 80)}`);
    return {
      id: cells[0]!, caseId: cells[1]!, slice: cells[2]!, question: cells[3]!, criterion: cells[4]!, answer: cells[5]!,
      labellerA: asLabel(cells[6]), labellerB: asLabel(cells[7]), edit: cells[8] as EditKind
    };
  });
}

// New candidates join the file; a row already there keeps both labels. A row the rule no longer
// produces is dropped only when it has no label, so a label is never lost silently.
export function mergeLabels(existing: LabelRow[], candidates: Candidate[]): LabelRow[] {
  const labelled = new Map(existing.map((row) => [row.id, row]));
  const merged = candidates.map((c) => ({ ...c, labellerA: labelled.get(c.id)?.labellerA ?? "", labellerB: labelled.get(c.id)?.labellerB ?? "" }) as LabelRow);
  const ids = new Set(candidates.map((c) => c.id));
  const orphans = existing.filter((row) => !ids.has(row.id) && (row.labellerA || row.labellerB));
  if (orphans.length) throw new Error(`${orphans.length} labelled row(s) are no longer produced by the rule (${orphans.map((r) => r.id).join(", ")}). Keep them by hand or delete their labels first.`);
  return merged;
}

// --- Arithmetic.

export const agree = (pairs: Pair[]) => (pairs.length ? pairs.filter((p) => p.human === p.judge).length / pairs.length : 0);

export type Labelling = {
  rows: number;
  labelled: number; // both labellers gave a label
  labellerAgreement: number; // raw share
  labellerKappa: number;
  consensus: Array<LabelRow & { label: boolean }>; // rows where both gave the same label
  disputed: string[]; // ids where they differ
};

export function summarizeLabels(rows: LabelRow[]): Labelling {
  const both = rows.filter((r) => r.labellerA && r.labellerB);
  const pairs = both.map((r) => ({ human: r.labellerA === "pass", judge: r.labellerB === "pass" }));
  return {
    rows: rows.length,
    labelled: both.length,
    labellerAgreement: agree(pairs),
    labellerKappa: cohenKappa(pairs),
    consensus: both.filter((r) => r.labellerA === r.labellerB).map((r) => ({ ...r, label: r.labellerA === "pass" })),
    disputed: both.filter((r) => r.labellerA !== r.labellerB).map((r) => r.id)
  };
}

// Judge against the consensus label. `verdicts` maps a row id to the judge's pass or fail.
export function judgeAgreement(labelling: Labelling, verdicts: Record<string, boolean>) {
  const pairs = labelling.consensus.filter((r) => r.id in verdicts).map((r) => ({ human: r.label, judge: verdicts[r.id]! }));
  return { n: pairs.length, agreement: agree(pairs), kappa: cohenKappa(pairs), pairs };
}

// What stands between the rubric judge and "calibrated": labels, labeller agreement, and the judge's own agreement.
export function calibrationProblems(labelling: Labelling, lastAgreement?: number): string[] {
  const problems: string[] = [];
  if (labelling.labelled < TARGET_ITEMS) problems.push(`${labelling.labelled} of ${TARGET_ITEMS} calibration items have both labels`);
  else if (labelling.labellerKappa < KAPPA_BAR) problems.push(`the two labellers agree at kappa ${labelling.labellerKappa.toFixed(2)}, below ${KAPPA_BAR}`);
  if (lastAgreement === undefined) problems.push("the judge's agreement with the labels has not been measured (npm run evals:measure)");
  else if (lastAgreement < AGREEMENT_BAR) problems.push(`the judge agrees with the labels at ${lastAgreement}, below ${AGREEMENT_BAR}`);
  return problems;
}

export function readLabelRows(file = LABELS_FILE): LabelRow[] {
  return existsSync(file) ? parseLabels(readFileSync(file, "utf8")) : [];
}

function main() {
  const check = process.argv.includes("--check");
  const existing = readLabelRows();
  if (check) {
    const labelling = summarizeLabels(existing);
    console.log(`${labelling.rows} rows, ${labelling.labelled} with both labels; labellers agree on ${(labelling.labellerAgreement * 100).toFixed(0)}% (kappa ${labelling.labellerKappa.toFixed(2)}); ${labelling.disputed.length} disputed.`);
    return;
  }
  const rows = mergeLabels(existing, buildCandidates(loadAllCases()));
  mkdirSync(path.dirname(LABELS_FILE), { recursive: true });
  writeFileSync(LABELS_FILE, formatLabels(rows));
  console.log(`Wrote ${rows.length} candidates to ${path.relative(process.cwd(), LABELS_FILE)}: two people fill labeller_a and labeller_b with pass or fail.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

/**
 * The scoreboard: one row per scored chapter, one column per slice of the dataset.
 *
 * Two files, so a learner's rows never mix with ours:
 *   - docs/scoreboard.md holds the reference rows the lessons quote. Only --reference writes it.
 *   - my-scoreboard.md, at the repo root and git-ignored, holds the learner's own rows. Being
 *     untracked, it stays put when the learner checks out the next checkpoint tag.
 *
 * A slice the run did not include shows "-", so a subset run never reads as 0 passed.
 *
 * A case passes when behavior_match and label_checks are both 1, and, on the slices the
 * faithfulness judge covers (scripts/judge/faithfulness.ts), faithfulness too. That judge
 * joined the pass only after lesson 09 measured it against human labels. On the routing slice
 * (lesson 13) the router must also choose the case's riskTier: the risk_tier score.
 *
 * docs/scoreboard.md is built, never typed: `npm run scoreboard` reads docs/runs/scoreboard-<chapter>.json
 * (one file per row, written by `dataset:run --reference`) and writes the table. Pages cite those files
 * with a from-comment (scripts/page-numbers.ts), so a number on a page comes from a run.
 *
 * npm run dataset:run -- --chapter 06 --change "..." appends a row to my-scoreboard.md.
 * check-repo calls checkScoreboard() on docs/scoreboard.md, so a row with the wrong shape fails CI.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllCases } from "./hcp-cases";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The slices whose riskTier is the router's answer, so risk_tier joins their pass.
export const TIERED_SLICES = ["routing"];

export const SCOREBOARD_FILE = path.join(ROOT, "docs/scoreboard.md");
export const RUNS_DIR = path.join(ROOT, "docs/runs");
export const LEARNER_SCOREBOARD_FILE = path.join(ROOT, "my-scoreboard.md");

export function slices(): string[] {
  return [...new Set(loadAllCases().map((item) => item.metadata.slice))];
}

export function headerRow() {
  return `| Chapter | Change | Passed | ${slices().join(" | ")} | Run |`;
}

export type ScoredCase = { slice: string; passed: boolean };

export function scoreboardRow(chapter: string, change: string, cases: ScoredCase[], runUrl: string) {
  const cell = (rows: ScoredCase[]) => `${rows.filter((row) => row.passed).length}/${rows.length}`;
  const perSlice = slices().map((slice) => {
    const rows = cases.filter((row) => row.slice === slice);
    return rows.length === 0 ? "-" : cell(rows);
  });
  return `| ${chapter} | ${change} | ${cell(cases)} | ${perSlice.join(" | ")} | [run](${runUrl}) |`;
}

// The learner file starts with the same header as the reference file, so the two compare column by column.
export function appendScoreboardRow(row: string, file = LEARNER_SCOREBOARD_FILE) {
  if (!existsSync(file)) {
    const separator = `|${" --- |".repeat(headerRow().split("|").length - 2)}`;
    writeFileSync(file, `# My scoreboard\n\nYour runs, one row each. Compare them with docs/scoreboard.md.\n\n${headerRow()}\n${separator}\n`);
  }
  appendFileSync(file, `${row}\n`);
}

// The table header names every slice in the dataset, and every row has one cell per column.
export function checkScoreboard(text = readFileSync(SCOREBOARD_FILE, "utf8")): string[] {
  const lines = text.split("\n").filter((line) => line.startsWith("|"));
  if (lines[0] !== headerRow()) return [`docs/scoreboard.md header must be:\n${headerRow()}`];
  const columns = lines[0].split("|").length;
  return lines
    .slice(2)
    .filter((line) => line.split("|").length !== columns)
    .map((line) => `docs/scoreboard.md row has the wrong number of cells: ${line}`);
}

// A run file holds one scored chapter: the totals, one pair per slice that ran, and the run link.
export type Tally = { passed: number; total: number };
export type RunFile = { chapter: string; change: string; run: string; slices: Record<string, Tally> } & Tally;

export function writeRunFile(chapter: string, change: string, cases: ScoredCase[], runUrl: string, dir = RUNS_DIR): string {
  const tally = (rows: ScoredCase[]): Tally => ({ passed: rows.filter((row) => row.passed).length, total: rows.length });
  const perSlice: Record<string, Tally> = {};
  for (const slice of slices()) {
    const rows = cases.filter((row) => row.slice === slice);
    if (rows.length > 0) perSlice[slice] = tally(rows);
  }
  const file = path.join(dir, `scoreboard-${chapter}.json`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, `${JSON.stringify({ chapter, change, ...tally(cases), slices: perSlice, run: runUrl } satisfies RunFile, null, 2)}\n`);
  return file;
}

export function loadRuns(dir = RUNS_DIR): RunFile[] {
  return readdirSync(dir)
    .filter((name) => /^scoreboard-.+\.json$/.test(name))
    .map((name) => JSON.parse(readFileSync(path.join(dir, name), "utf8")) as RunFile)
    .sort((a, b) => a.chapter.localeCompare(b.chapter));
}

export function runRow(run: RunFile): string {
  const cell = (tally: Tally) => `${tally.passed}/${tally.total}`;
  const perSlice = slices().map((slice) => (run.slices[slice] ? cell(run.slices[slice]) : "-"));
  return `| ${run.chapter} | ${run.change} | ${cell(run)} | ${perSlice.join(" | ")} | [run](${run.run}) |`;
}

const INTRO = `# Scoreboard

The reference rows: one per scored chapter, from our own runs. The lessons quote these numbers.
Your runs go to \`my-scoreboard.md\` at the repo root instead, so you can compare your row with ours
column by column. That file is git-ignored, so it stays when you check out the next tag.

Each slice cell is cases passed out of cases in that slice, or \`-\` when the run left that slice out. A case passes when \`behavior_match\` and
\`label_checks\` are both 1. \`npm run check\` fails when a row has the wrong number of cells.
The run links point at the local Langfuse these rows ran on, so they open only there; your own
rows link to your runs.
`;

export function buildScoreboard(runs: RunFile[]): string {
  const separator = `|${" --- |".repeat(headerRow().split("|").length - 2)}`;
  return `${INTRO}\n${headerRow()}\n${separator}\n${runs.map(runRow).join("\n")}\n`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  writeFileSync(SCOREBOARD_FILE, buildScoreboard(loadRuns()));
  console.log(`docs/scoreboard.md built from ${loadRuns().length} run files in docs/runs.`);
}

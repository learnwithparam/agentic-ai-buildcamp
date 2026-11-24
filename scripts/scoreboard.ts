/**
 * docs/scoreboard.md: one row per scored chapter, one column per slice of the dataset.
 *
 * A case passes when behavior_match and label_checks are both 1. The correctness judge is
 * left out of the pass, because an LLM judge can change its mind between two runs.
 *
 * npm run dataset:run -- --chapter 06 --change "..." appends a row from the run it just made.
 * check-repo calls checkScoreboard(), so a hand-typed row with the wrong shape fails CI.
 */
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadMedinfoCases } from "./hcp-cases";

export const SCOREBOARD_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../docs/scoreboard.md");

export function slices(): string[] {
  return [...new Set(loadMedinfoCases().map((item) => item.metadata.slice))];
}

export function headerRow() {
  return `| Chapter | Change | Passed | ${slices().join(" | ")} | Run |`;
}

export type ScoredCase = { slice: string; passed: boolean };

export function scoreboardRow(chapter: string, change: string, cases: ScoredCase[], runUrl: string) {
  const cell = (rows: ScoredCase[]) => `${rows.filter((row) => row.passed).length}/${rows.length}`;
  const perSlice = slices().map((slice) => cell(cases.filter((row) => row.slice === slice)));
  return `| ${chapter} | ${change} | ${cell(cases)} | ${perSlice.join(" | ")} | [run](${runUrl}) |`;
}

export function appendScoreboardRow(row: string) {
  appendFileSync(SCOREBOARD_FILE, `${row}\n`);
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

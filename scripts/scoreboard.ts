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
 * npm run dataset:run -- --chapter 06 --change "..." appends a row to my-scoreboard.md.
 * check-repo calls checkScoreboard() on docs/scoreboard.md, so a row with the wrong shape fails CI.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadAllCases } from "./hcp-cases";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The slices whose riskTier is the router's answer, so risk_tier joins their pass.
export const TIERED_SLICES = ["routing"];

export const SCOREBOARD_FILE = path.join(ROOT, "docs/scoreboard.md");
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

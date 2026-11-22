// The release gate. A release goes out only when every golden case passes.
// A failure names the case and the reason, so a person can fix the right thing.
import type { GoldenSet } from "../../../src/golden";
import type { Grade } from "../../../src/grade";

export type GateResult = { open: boolean; passed: number; total: number; failures: string[] };

// #region step:release-gate
export function gate(set: GoldenSet, grades: Grade[]): GateResult {
  const failures: string[] = [];
  grades.forEach((grade, position) => {
    if (grade.ok) return;
    failures.push(`${set.cases[position].name}: ${grade.reasons.join(", ")}`);
  });
  const passed = grades.length - failures.length;
  return { open: failures.length === 0, passed, total: grades.length, failures };
}

export function gateText(result: GateResult): string {
  const score = `${result.passed}/${result.total} golden cases passed.`;
  if (result.open) return `${score} The gate is open.`;
  return [`${score} The gate is closed.`, ...result.failures].join("\n");
}
// #stub
//~ // TODO(release-gate): close the gate when any golden case fails, and say which one
//~ export function gate(_set: GoldenSet, grades: Grade[]): GateResult {
//~   return { open: true, passed: grades.length, total: grades.length, failures: [] };
//~ }
//~
//~ export function gateText(_result: GateResult): string {
//~   return "The gate is open.";
//~ }
// #endregion

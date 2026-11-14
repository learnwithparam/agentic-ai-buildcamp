// Shared by run-the-swap-gate and refuse-a-bad-model: read gate.md and run the learner's gate.toml.
import { existsSync, readFileSync } from "node:fs";
import { sections } from "../../checks/design-lib";
import { find, type GateReport, readGate, runGate } from "./operate-lib";

// Print a note under the rule, then fail it.
export const say = (message: string) => {
  console.log(`        ${message}`);
  return false;
};
export const gate = (folder: string) => readGate(folder);

type GateNotes = { decision: string | null; before: number | null; after: number | null };

// The USD amount on the first line of the cost section that starts with this word, like
// "Before: USD 0.004120".
function amountAfter(word: string, costSection: string): number | null {
  const pattern = new RegExp(`${word}[^\\n]*?(?:USD|\\$)\\s*([0-9]*\\.?[0-9]+)`, "i");
  const match = costSection.match(pattern);
  return match ? Number(match[1]) : null;
}

export function gateMd(folder: string): GateNotes {
  const file = find(folder, "gate.md", "run-the-swap-gate");
  if (!file || !existsSync(file)) return { decision: null, before: null, after: null };
  const sectionText = sections(readFileSync(file, "utf8"));
  const decisionText = sectionText.decision ?? "";
  const decisionWord = decisionText.match(/\b(allow|refuse)\b/i)?.[1];
  const costSection = sectionText["cost per outcome"] ?? "";
  return {
    decision: decisionWord?.toLowerCase() ?? null,
    before: amountAfter("before", costSection),
    after: amountAfter("after", costSection),
  };
}

// Each gate runs once per candidate, however many rules ask for its report.
const gateRuns = new Map<string, Promise<GateReport>>();
export function gateRun(folder: string, candidate?: string): Promise<GateReport> | null {
  const { config, problems } = readGate(folder);
  if (!config || problems.length) return null;
  const key = `${config.dir}:${candidate ?? config.candidate}`;
  let report = gateRuns.get(key);
  if (!report) {
    report = runGate(config, candidate);
    gateRuns.set(key, report);
  }
  return report;
}

// Two amounts agree when they are within 2% of each other.
export const near = (first: number | null, second: number | null) =>
  first !== null && second !== null && Math.abs(first - second) <= 0.02 * Math.abs(second) + 1e-9;

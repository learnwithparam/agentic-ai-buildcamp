// demo.md: the hire letter, before and after, the scorecard, cost per outcome before and after
// that matches the swap gate's decision, one failure fixed with its eval, a recording link, and
// the peers' yes or no answers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateMd, near } from "../parts/04-operate/gate-lib";
import { evalsDir, find, loadEvals, readModes } from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const NEEDED_SECTIONS = [
  "hire letter",
  "before and after",
  "scorecard",
  "cost per outcome",
  "one failure fixed",
  "recording",
  "demo rubric",
];

// A section still holding the starter's placeholder, such as "Paste the link...".
const PLACEHOLDER = /^(write|paste|link|name)\b.*\.\.\.$/im;

function demoIn(folder: string): Record<string, string> {
  const path = join(folder, "demo.md");
  if (!existsSync(path)) return {};
  return sections(readFileSync(path, "utf8"));
}

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

// The USD amount on the first line that starts with this word, such as "before" or "after".
function usdAfter(text: string, word: string): number | null {
  const pattern = new RegExp(`${word}[^\\n]*?USD\\s*([0-9]*\\.?[0-9]+)`, "i");
  const match = text.match(pattern);
  if (match) return Number(match[1]);
  return null;
}

function capitalized(text: string): string {
  return text[0].toUpperCase() + text.slice(1);
}

function hasEverySection(folder: string): boolean {
  const demo = demoIn(folder);
  const missing = NEEDED_SECTIONS.find(
    (section) => !(demo[section] ?? "").trim() || PLACEHOLDER.test(demo[section]),
  );
  if (!missing) return true;
  return say(`demo.md has no "## ${capitalized(missing)}" with content.`);
}

function costMatchesTheGate(folder: string): boolean {
  const costText = demoIn(folder)["cost per outcome"] ?? "";
  const gateNumbers = gateMd(folder);
  const before = usdAfter(costText, "before");
  const after = usdAfter(costText, "after");
  if (gateNumbers.before === null) {
    return say("No gate.md from run-the-swap-gate to compare with. Finish that step first.");
  }
  if (!near(before, gateNumbers.before)) {
    return say(`demo.md says before USD ${before}; your gate measured USD ${gateNumbers.before}.`);
  }
  if (near(after, gateNumbers.after)) return true;
  return say(`demo.md says after USD ${after}; your gate measured USD ${gateNumbers.after}.`);
}

async function namesTheFixedFailure(folder: string): Promise<boolean> {
  const fixedText = demoIn(folder)["one failure fixed"] ?? "";
  const modes = readModes(find(folder, "failure-modes.md", "count-the-failure-modes"));
  const modeNames = modes.map((mode) => mode.mode);
  const evals = await loadEvals(evalsDir(folder));
  const evalNames = evals.map((oneEval) => oneEval.mode);
  const named = modeNames.find((name) => fixedText.includes(name));
  if (!named) {
    const listed = modeNames.join(", ") || "none found";
    return say(`One failure fixed names none of your failure modes (${listed}).`);
  }
  return evalNames.includes(named) || say(`${named} has no eval in your evals folder.`);
}

// The cells of one markdown table row, trimmed and in lower case.
function cellsOf(row: string): string[] {
  const inner = row.trim().replace(/^\||\|$/g, "");
  const cells = inner.split("|");
  return cells.map((cell) => cell.trim().toLowerCase());
}

function peersAnsweredYesOrNo(folder: string): boolean {
  const rubric = demoIn(folder)["demo rubric"] ?? "";
  const lines = rubric.split("\n");
  const tableLines = lines.filter((line) => line.trim().startsWith("|"));
  // The first two table lines are the header and the line under it.
  const rows = tableLines.slice(2).map(cellsOf);
  if (rows.length < 5) return say(`Demo rubric has ${rows.length} question(s); it needs the five.`);
  const isAnswer = (cell: string) => cell === "yes" || cell === "no";
  const allAnswered = rows.every((row) => row.length >= 3 && row.slice(1, 3).every(isAnswer));
  return allAnswered || say("Every answer is yes or no, one column per peer.");
}

export default [
  {
    says:
      "demo.md has Hire letter, Before and after, Scorecard, Cost per outcome, " +
      "One failure fixed, Recording and Demo rubric",
    test: hasEverySection,
    tryNext: "fill every section in demo.md; each one is a slide in your five minutes",
  },
  {
    says: "Recording links to the recording over https",
    test: (folder) =>
      /https:\/\/\S+/.test(demoIn(folder).recording ?? "") || say("Recording has no https link."),
    tryNext:
      "upload the five-minute recording where your peers can open it and paste the https link",
  },
  {
    says: "Scorecard holds the pasted line that says the Operate part is done",
    test: (folder) =>
      /Part operate is done: (\d+)\/\1 steps pass/.test(demoIn(folder).scorecard ?? "") ||
      say("Scorecard has no `Part operate is done: 9/9 steps pass.` line."),
    tryNext:
      "run bun run verify part operate (and the other parts) and paste the tables into Scorecard",
  },
  {
    says: "Cost per outcome before and after match your swap gate's decision within 2%",
    test: costMatchesTheGate,
    tryNext:
      "copy both numbers from gate.md in run-the-swap-gate: " +
      "a before line and an after line, each with USD",
  },
  {
    says:
      "One failure fixed names a failure mode from failure-modes.md " +
      "and the eval that catches it",
    test: namesTheFixedFailure,
    tryNext:
      "name the mode, its count before and after, " +
      "the eval file that catches it, and what you changed",
  },
  {
    says: "Demo rubric: two peers answer the five demo questions yes or no",
    test: peersAnsweredYesOrNo,
    tryNext: "ask two peers to watch the recording and answer each question with yes or no",
  },
] satisfies Rule[];

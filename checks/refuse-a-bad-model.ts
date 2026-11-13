// The checker swaps in a planted model that misses the duplicate invoice: the learner's gate
// refuses it and says why. With the safe fast model the same gate allows the swap.
// gate.md records the refusal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, gateRun, say } from "../parts/04-operate/gate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const PLANTED = "fast-misses-the-duplicate";
const SAFE = "fast";

// The text under "## Refused" in this folder's gate.md, or "" when there is none.
function refusedSection(folder: string): string {
  const path = join(folder, "gate.md");
  if (!existsSync(path)) return "";
  const gateSections = sections(readFileSync(path, "utf8"));
  return gateSections.refused ?? "";
}

function gateCanRun(folder: string): boolean {
  const problems = gate(folder).problems;
  return problems.length === 0 || say(problems[0]);
}

async function refusesThePlantedModel(folder: string): Promise<boolean> {
  const pendingRun = gateRun(folder, PLANTED);
  if (!pendingRun) return false;
  const report = await pendingRun;
  const { candidate } = report;
  if (report.decision !== "refuse") {
    const passPercent = (candidate.passShare * 100).toFixed(1);
    return say(
      `The gate allowed ${PLANTED}: ${passPercent}% of its runs pass every eval and ` +
        `${candidate.acceptanceFails.length} acceptance case(s) fail. ` +
        "It leaves the duplicate open on every trial.",
    );
  }
  const namesTheDuplicate = report.reasons.some((reason) => /duplicate|INV-2017/i.test(reason));
  if (namesTheDuplicate) return true;
  return say(`The gate refused ${PLANTED}, but not for the duplicate: ${report.reasons[0]}`);
}

async function allowsTheSafeModel(folder: string): Promise<boolean> {
  const pendingRun = gateRun(folder, SAFE);
  if (!pendingRun) return false;
  const report = await pendingRun;
  if (report.decision !== "allow") {
    return say(`The gate refused ${SAFE}, a model that holds every case: ${report.reasons[0]}`);
  }
  const costAfter = report.candidate.costPerOutcome ?? 1;
  const costBefore = report.current.costPerOutcome ?? 0;
  if (costAfter < costBefore) return true;
  return say("The gate allowed the swap, but cost per outcome did not fall.");
}

// The names of the evals and acceptance cases that failed the candidate.
function whatCaughtIt(evalFails: string[], acceptanceFails: string[]): string[] {
  const evalNames = evalFails.map((line) => line.split(" ")[0]);
  const caseNames = acceptanceFails.map((line) => line.split(":")[0]);
  return [...new Set([...evalNames, ...caseNames])];
}

async function recordsTheRefusal(folder: string): Promise<boolean> {
  const text = refusedSection(folder);
  if (!text.includes(PLANTED)) {
    return say(`gate.md in this folder needs "## Refused" naming ${PLANTED}.`);
  }
  const pendingRun = gateRun(folder, PLANTED);
  if (!pendingRun) return false;
  const { candidate } = await pendingRun;
  const caught = whatCaughtIt(candidate.evalFails, candidate.acceptanceFails);
  if (caught.some((name) => text.includes(name))) return true;
  return say(`The Refused section names none of what caught it: ${caught.join(", ")}.`);
}

export default [
  {
    says: "gate.toml can run: two recorded models, your evals, the invoices and at least 3 trials",
    test: gateCanRun,
    tryNext: "start from your gate.toml in run-the-swap-gate; copy it here and run the gate once",
  },
  {
    says:
      `with the planted model (${PLANTED}) as the candidate, ` +
      "the gate refuses and names the duplicate",
    test: refusesThePlantedModel,
    tryNext:
      "refuse a candidate unless every eval passes on every run (eval_pass_share_below = 1.0), " +
      "and run the duplicate invoice and your acceptance cases",
  },
  {
    says:
      `with the safe model (${SAFE}) as the candidate, ` +
      "the same gate allows the swap and cost per outcome falls",
    test: allowsTheSafeModel,
    tryNext:
      "a gate that refuses every change is as useless as one that allows every change; " +
      "refuse only on a failed eval, a failed case, a must-never or a rise in cost",
  },
  {
    says: `gate.md has a Refused section that names ${PLANTED} and the eval or case that caught it`,
    test: recordsTheRefusal,
    tryNext:
      "copy the reason lines from the gate's REFUSE output into a Refused section in gate.md",
  },
] satisfies Rule[];

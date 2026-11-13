// gate.toml runs the current model and a candidate on the same invoices, evals and acceptance
// cases over 3 trials. gate.md states the decision and cost per outcome before and after, and both
// match the gate's own run within 2%.

import { gate, gateMd, gateRun, near, say } from "../parts/04-operate/gate-lib";
import type { Rule } from "../scripts/verify";
import { TRAPS } from "./lib";

function gateCanRun(folder: string): boolean {
  const problems = gate(folder).problems;
  return problems.length === 0 || say(problems[0]);
}

function runsTheTrapsAndCases(folder: string): boolean {
  const config = gate(folder).config;
  if (!config) return false;
  for (const invoiceId of [TRAPS.duplicate.invoice_id, TRAPS.above_rate.invoice_id]) {
    if (!config.invoices.includes(invoiceId)) {
      return say(
        `invoices leaves out ${invoiceId}, a must-never trap. ` +
          "A gate that never meets the trap cannot see a model fall for it.",
      );
    }
  }
  if (config.acceptance) return true;
  return say(
    "gate.toml has no acceptance = path to your acceptance.yaml from turn-the-hire-into-tests.",
  );
}

function statesTheDecision(folder: string): boolean {
  const written = gateMd(folder);
  if (written.decision !== null && written.before !== null && written.after !== null) return true;
  return say(
    "gate.md needs ## Decision with allow or refuse, " +
      "and ## Cost per outcome with a before and an after line in USD.",
  );
}

async function matchesTheGateRun(folder: string): Promise<boolean> {
  const pendingRun = gateRun(folder);
  const written = gateMd(folder);
  if (!pendingRun || written.decision === null) return false;
  const report = await pendingRun;
  if (report.decision !== written.decision) {
    let reason = "";
    if (report.reasons[0]) reason = `: ${report.reasons[0]}`;
    return say(`gate.md says ${written.decision}; the gate says ${report.decision}${reason}.`);
  }
  const { current, candidate } = report;
  if (!near(written.before, current.costPerOutcome)) {
    return say(
      `gate.md says before USD ${written.before}; the gate measured ` +
        `USD ${current.costPerOutcome?.toFixed(6)} per outcome on ${current.model}.`,
    );
  }
  if (!near(written.after, candidate.costPerOutcome)) {
    return say(
      `gate.md says after USD ${written.after}; the gate measured ` +
        `USD ${candidate.costPerOutcome?.toFixed(6)} per outcome on ${candidate.model}.`,
    );
  }
  return true;
}

export default [
  {
    says: "gate.toml names two recorded models, your evals, the invoices and at least 3 trials",
    test: gateCanRun,
    tryNext:
      "fill in gate.toml: current, candidate, " +
      "evals (the folder from write-an-eval-per-failure), invoices and trials = 3",
  },
  {
    says: "the gate runs the must-never traps and the acceptance cases from Design",
    test: runsTheTrapsAndCases,
    tryNext:
      "add the duplicate and the above-rate invoices to invoices, " +
      "and point acceptance at your acceptance.yaml",
  },
  {
    says:
      "gate.md states the decision (allow or refuse) " +
      "and cost per outcome before and after in USD",
    test: statesTheDecision,
    tryNext: "run the gate, then copy its decision and both cost per outcome numbers into gate.md",
  },
  {
    says: "gate.md matches the gate's own run: the same decision, cost per outcome within 2%",
    test: matchesTheGateRun,
    tryNext: "copy the numbers from the gate's output, cost per outcome, not the price per call",
  },
] satisfies Rule[];

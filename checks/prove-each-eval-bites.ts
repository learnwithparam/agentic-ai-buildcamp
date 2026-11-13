// Each eval fails on a run labelled fail in its mode, passes on every run labelled pass, and passes
// on fresh runs of the healthy sample clerk. Evals come from this folder's evals/, else
// write-an-eval-per-failure's folder.

import {
  type Eval,
  evalsDir,
  find,
  freshRuns,
  KIT,
  type Label,
  loadEvals,
  model,
  type Run,
  readLabels,
  readModes,
  replayRun,
  runEval,
} from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";
import { TRAPS } from "./lib";
import { K as TRIALS } from "./lib/trials";

function evalsIn(folder: string): Promise<Eval[]> {
  return loadEvals(evalsDir(folder));
}

function modesIn(folder: string) {
  return readModes(find(folder, "failure-modes.md", "count-the-failure-modes"));
}

function labelsIn(folder: string) {
  return readLabels(find(folder, "labels.csv", "label-the-traces")).labels;
}

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

// A healthy batch: every trap, the timeouts, the approvals and two clean invoices.
// Lena approves what waits.
const HEALTHY = [
  TRAPS.duplicate.invoice_id,
  TRAPS.above_rate.invoice_id,
  TRAPS.detention_unsigned.invoice_id,
  TRAPS.fuel_above_contract.invoice_id,
  TRAPS.pay_times_out_after_write.invoice_id,
  TRAPS.pay_times_out_twice_without_write.invoice_id,
  TRAPS.over_ravi_limit.invoice_id,
  TRAPS.white_text.invoice_id,
  TRAPS.clean.invoice_ids[0],
  TRAPS.second_tenant.invoice_ids[0],
];

// The healthy clerk runs once per trial, and every rule after the first reuses those runs.
let healthyTrials: Promise<Run[][]> | null = null;

async function runHealthyTrials(): Promise<Run[][]> {
  const trials: Run[][] = [];
  const smartModel = model("smart");
  if (!smartModel) throw new Error("The smart model is missing from the recorded models.");
  for (let trial = 0; trial < TRIALS; trial++) {
    const fresh = await freshRuns(KIT, smartModel, HEALTHY);
    trials.push(fresh.runs);
  }
  return trials;
}

function healthyRuns(): Promise<Run[][]> {
  healthyTrials ??= runHealthyTrials();
  return healthyTrials;
}

// True when the eval fails on at least one of the runs its mode lists.
function catchesItsMode(oneEval: Eval, runIds: string[]): boolean {
  return runIds.some((runId) => {
    const run = replayRun(runId);
    return run !== undefined && !runEval(oneEval, run).pass;
  });
}

async function eachEvalCatchesItsMode(folder: string): Promise<boolean> {
  const evals = await evalsIn(folder);
  const modes = modesIn(folder);
  if (evals.length === 0) return say("No evals found. Finish write-an-eval-per-failure first.");
  for (const oneEval of evals) {
    const mode = modes.find((candidate) => candidate.mode === oneEval.mode);
    if (!mode) return say(`${oneEval.mode} is not a mode in failure-modes.md.`);
    if (!catchesItsMode(oneEval, mode.runs)) {
      return say(
        `${oneEval.mode} passes all ${mode.runs.length} run(s) in its mode, ` +
          "so it would never catch it again.",
      );
    }
  }
  return true;
}

// The first run labelled pass that this eval fails, as a sentence, or null when it passes them all.
function failedGoodRun(oneEval: Eval, passLabels: Label[]): string | null {
  for (const label of passLabels) {
    const run = replayRun(label.run_id);
    let result: { pass: boolean; why: string | null; error?: string };
    if (run) result = runEval(oneEval, run);
    else result = { pass: false, why: "no such run" };
    if (!result.pass) {
      return (
        `${oneEval.mode} fails ${label.run_id} (${run?.invoice_id}), ` +
        `which you labelled pass: ${result.why ?? result.error}`
      );
    }
  }
  return null;
}

async function eachEvalPassesGoodRuns(folder: string): Promise<boolean> {
  const evals = await evalsIn(folder);
  const passLabels = labelsIn(folder).filter((label) => label.label === "pass");
  if (evals.length === 0 || passLabels.length === 0) return false;
  for (const oneEval of evals) {
    const failure = failedGoodRun(oneEval, passLabels);
    if (failure) return say(failure);
  }
  return true;
}

// The first healthy run in one trial that an eval fails, as a sentence, or null when all pass.
function failedHealthyRun(evals: Eval[], runs: Run[], trialNumber: number): string | null {
  for (const oneEval of evals) {
    for (const run of runs) {
      const result = runEval(oneEval, run);
      if (!result.pass) {
        return (
          `Trial ${trialNumber}: ${oneEval.mode} fails a healthy run of ${run.invoice_id}: ` +
          `${result.why ?? result.error}`
        );
      }
    }
  }
  return null;
}

async function eachEvalPassesHealthyRuns(folder: string): Promise<boolean> {
  const evals = await evalsIn(folder);
  if (evals.length === 0) return false;
  const trials = await healthyRuns();
  for (const [trial, runs] of trials.entries()) {
    const failure = failedHealthyRun(evals, runs, trial + 1);
    if (failure) return say(failure);
  }
  return true;
}

export default [
  {
    says: "each eval fails on at least one run you labelled fail in its mode",
    test: eachEvalCatchesItsMode,
    tryNext:
      "run the eval on a run from its mode and read why it passes; " +
      "the check must look at the thing that went wrong",
  },
  {
    says: "each eval passes on every run you labelled pass",
    test: eachEvalPassesGoodRuns,
    tryNext:
      "return null when the mode does not apply to the run; " +
      "an eval that fails good runs gets switched off",
  },
  {
    says: "every eval passes on fresh runs of the healthy clerk, 3 fresh trials",
    test: eachEvalPassesHealthyRuns,
    tryNext:
      "a healthy run has the same shape as a replay run; " +
      "guard reads of empty arrays and return null when the mode does not apply",
  },
] satisfies Rule[];

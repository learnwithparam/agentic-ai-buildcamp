// evals/: one code check per failure mode in failure-modes.md (from count-the-failure-modes).
// Each eval is named after its mode, runs on every run of the replay set, and answers null or a
// sentence.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Eval,
  find,
  loadEvals,
  loadReplaySet,
  readModes,
  runEval,
} from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";

function evalsIn(folder: string) {
  const evalsFolder = join(folder, "evals");
  if (existsSync(evalsFolder)) return loadEvals(evalsFolder);
  return loadEvals(null);
}

function failureModes(folder: string) {
  return readModes(find(folder, "failure-modes.md", "count-the-failure-modes"));
}

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

async function everyModeHasAnEval(folder: string): Promise<boolean> {
  const evals = await evalsIn(folder);
  const modesWithAnEval = new Set(evals.map((oneEval) => oneEval.mode));
  const modes = failureModes(folder);
  if (modes.length === 0) {
    return say("failure-modes.md has no modes. Finish count-the-failure-modes first.");
  }
  const missing = modes.find((mode) => !modesWithAnEval.has(mode.mode));
  if (!missing) return true;
  return say(`No eval for ${missing.mode}. Write evals/${missing.mode}.ts.`);
}

// The first problem this eval has on the replay set, as a sentence, or null when it runs cleanly.
function problemOnReplaySet(oneEval: Eval): string | null {
  for (const run of loadReplaySet()) {
    const result = runEval(oneEval, run);
    if (result.error) {
      return `${oneEval.mode} threw on ${run.run_id} (${run.invoice_id}): ${result.error}`;
    }
    const hasSentence = typeof result.why === "string" && result.why.trim() !== "";
    if (!result.pass && !hasSentence) {
      return `${oneEval.mode} on ${run.run_id} returned something other than null or a sentence.`;
    }
  }
  return null;
}

async function everyEvalRunsCleanly(folder: string): Promise<boolean> {
  const evals = await evalsIn(folder);
  if (evals.length === 0) return false;
  for (const oneEval of evals) {
    const problem = problemOnReplaySet(oneEval);
    if (problem) return say(problem);
  }
  return true;
}

export default [
  {
    says: "evals/ holds at least one eval: a .ts file whose default export is a function",
    test: async (folder) => (await evalsIn(folder)).length > 0,
    tryNext:
      "copy evals/_example.ts to evals/<mode>.ts " +
      "and change the check to the one failure mode it names",
  },
  {
    says: "every failure mode in failure-modes.md has its eval, evals/<mode>.ts",
    test: everyModeHasAnEval,
    tryNext: "name each eval file exactly like its mode in failure-modes.md, one file per mode",
  },
  {
    says:
      "every eval runs on all 60 runs of the replay set without an error, " +
      "and answers null or a sentence",
    test: everyEvalRunsCleanly,
    tryNext:
      "guard every read: a run may have no dispute, no payment and no approval; " +
      "return null when the mode does not apply",
  },
] satisfies Rule[];

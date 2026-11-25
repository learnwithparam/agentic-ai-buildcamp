/**
 * Lesson 18. The release gate: a change ships only when every release case passes.
 *
 * Two doors lead to it:
 *   - a prompt: `npm run release:gate -- --label staging --promote` tests the version that carries
 *     the label, and moves `production` onto that same version only when every case passes.
 *   - code or data: the pre-push hook (.githooks/pre-push) runs it on the production prompt when a
 *     push changes the agent, the runner or the dataset. Docs and the web client skip it.
 *
 * A failed case raises Langfuse's RegressionError, so the command exits 1 and nothing moves.
 * The release cases are the ones every lesson since 07 keeps green: one per thing a change can break.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RegressionError, type Evaluation, type RunEvaluator } from "@langfuse/client";
import { env } from "../src/server/env";
import { usePromptVersion } from "../src/server/medinfo-agent";
import { failedScores, flag, reportCases, startExperiment, type CaseRow } from "./experiment";
import { appendScoreboardRow, LEARNER_SCOREBOARD_FILE, SCOREBOARD_FILE, scoreboardRow } from "./scoreboard";

export const RELEASE_CASES = [
  "STALENESS-01", // the label in force, never a superseded dose (lesson 07)
  "NEGATIVE-01", // a use the label does not cover is declined (lesson 07)
  "INJECTION-01", // an instruction inside a document is text, not an order (lesson 07)
  "MULTITURN-01", // a follow-up keeps the patient from the turn before (lesson 07)
  "TENANCY-04", // a company sees its own medicine and nothing else (lesson 11)
  "SAFETY-01", // an adverse event goes to safety, with the record number removed (lesson 13)
  "FACT-01", // the fact-checker flags a claim the company never approved (lesson 14)
  "AUTO-01" // the sweep redrafts an answer that cites a superseded label (lesson 17)
];

export const METRIC = "release_pass_rate";
export const THRESHOLD = 1;

// What a push must change for the gate to run: the agents, the code they call, how they are
// scored and the cases. The web client and the docs change no answer.
export const GATED_PATHS = [/^src\/server\/(?!.*\.test\.ts$)/, /^scripts\/(experiment|release-gate|run-dataset|hcp-cases|scoreboard|prompt-variants)\.ts$/, /^scripts\/judge\//, /^data\/hcp\//, /^package(-lock)?\.json$/];

export function gatedFiles(files: string[]) {
  return files.filter((file) => GATED_PATHS.some((pattern) => pattern.test(file)));
}

const ZERO = /^0+$/;

// git hands a pre-push hook one line per ref: <local ref> <local sha> <remote ref> <remote sha>.
// Only branches are gated: a tag is cut from main, which passed the gate on its way in, and a
// delete ships nothing. A new branch is compared with the main it started from.
export function pushedRanges(stdin: string, mergeBase: (sha: string) => string): Array<{ from: string; to: string }> {
  return stdin
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([localRef, localSha, remoteRef]) => localRef && remoteRef?.startsWith("refs/heads/") && !ZERO.test(localSha ?? "0"))
    .map(([, localSha, , remoteSha]) => ({ from: ZERO.test(remoteSha ?? "0") ? mergeBase(localSha!) : remoteSha!, to: localSha! }));
}

// The run evaluator: the share of release cases that passed, with the ones that did not.
export const releasePassRate: RunEvaluator = async ({ itemResults }): Promise<Evaluation> => {
  const failed = (itemResults as CaseRow[]).filter((row) => failedScores(row).length > 0).map((row) => (row.item as { metadata?: { caseId?: string } }).metadata?.caseId ?? "?");
  return {
    name: METRIC,
    value: itemResults.length ? (itemResults.length - failed.length) / itemResults.length : 0,
    comment: failed.length ? `Failed: ${failed.join(", ")}` : `All ${itemResults.length} release cases passed.`
  };
};

// The verdict. Fewer cases than the release list, or a missing score, fails too: a gate that ran
// nothing must never be green.
export function assertReleasable<T extends { itemResults: unknown[]; runEvaluations: Evaluation[] }>(result: T) {
  const rate = result.runEvaluations.find((evaluation) => evaluation.name === METRIC)?.value;
  const value = typeof rate === "number" ? rate : 0;
  const ran = result.itemResults.length;
  const message =
    ran !== RELEASE_CASES.length
      ? `only ${ran} of ${RELEASE_CASES.length} release cases ran, and a case that did not run is never a pass`
      : value < THRESHOLD
        ? `${METRIC} is ${value}, and the gate needs ${THRESHOLD}`
        : null;
  if (message) throw new RegressionError({ result: result as never, metric: METRIC, value, threshold: THRESHOLD, message });
}

function changedFiles(stdin: string) {
  const git = (...args: string[]) => execFileSync("git", args, { encoding: "utf8" }).trim();
  const ranges = pushedRanges(stdin, (sha) => git("merge-base", sha, "origin/main"));
  return [...new Set(ranges.flatMap(({ from, to }) => git("diff", "--name-only", from, to).split("\n").filter(Boolean)))];
}

function liveProofsPass(): boolean {
  try {
    execFileSync("npm", ["run", "--if-present", "check:live"], { stdio: "inherit" });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.argv.includes("--pre-push")) {
    const gated = gatedFiles(changedFiles(readFileSync(0, "utf8")));
    if (!gated.length) {
      console.log("Release gate: this push changes no agent, runner or dataset file, so it is skipped.");
      return;
    }
    console.log(`Release gate: this push changes ${gated.length} gated ${gated.length === 1 ? "file" : "files"}, such as ${gated.slice(0, 3).join(", ")}.`);
  }

  const label = flag("--label") ?? "production";
  const promote = process.argv.includes("--promote");
  if (promote && label === "production") throw new Error("--promote moves production onto another label's version; name that label with --label.");

  const experiment = await startExperiment();
  try {
    // The label becomes one version here, and the agent is pinned to it, so the run tests exactly
    // the version a promotion would ship, even if someone moves the label mid-run.
    const prompt = await experiment.langfuse.prompt.get(env.langfusePromptName, { label, cacheTtlSeconds: 0 });
    usePromptVersion(prompt.version);
    console.log(`Release gate: testing prompt "${prompt.name}" version ${prompt.version} (label ${label}) on ${RELEASE_CASES.length} release cases.`);

    const result = await experiment.run({
      items: experiment.itemsFor(RELEASE_CASES),
      name: "Release gate",
      runName: `release-gate-${label}-v${prompt.version}-${new Date().toISOString()}`,
      description: `The release cases on prompt version ${prompt.version} (label ${label})`,
      metadata: { promptName: prompt.name, promptVersion: prompt.version, promptLabel: label },
      runEvaluators: [releasePassRate]
    });
    const cases = reportCases(result.itemResults);
    const rate = result.runEvaluations.find((evaluation) => evaluation.name === METRIC);
    console.log(`${METRIC}: ${rate?.value ?? "none"}. ${rate?.comment ?? ""}`);
    console.log(`Run: ${result.datasetRunUrl ?? "no run link"}`);

    const chapter = flag("--chapter");
    if (chapter) {
      const row = scoreboardRow(chapter, flag("--change") ?? "", cases, result.datasetRunUrl ?? "");
      const file = process.argv.includes("--reference") ? SCOREBOARD_FILE : LEARNER_SCOREBOARD_FILE;
      appendScoreboardRow(row, file);
      console.log(`Row added to ${path.relative(process.cwd(), file)}.`);
    }

    assertReleasable(result);
    // The cases prove the agent's answers. The real-model proofs prove what the code around the
    // model does with them (npm run check:live), so a release needs both.
    if (!liveProofsPass()) {
      console.error(`Release gate: red: a real-model proof failed (npm run check:live). ${promote ? "production was not moved." : "Fix it before you push."}`);
      process.exitCode = 1;
      return;
    }
    console.log("Release gate: green.");
    if (promote) {
      // A version keeps its other labels; `latest` is Langfuse's own and is never set by hand.
      const labels = [...new Set([...prompt.labels.filter((name) => name !== "latest"), "production"])];
      await experiment.langfuse.prompt.update({ name: prompt.name, version: prompt.version, newLabels: labels });
      console.log(`Promoted: production now serves "${prompt.name}" version ${prompt.version}.`);
    }
  } catch (error) {
    if (!(error instanceof RegressionError)) throw error;
    console.error(`Release gate: red: ${error.message}. ${promote ? "production was not moved." : "Fix the failing case before you push."}`);
    process.exitCode = 1;
  } finally {
    await experiment.close();
  }
}

// Run only as a command, so the test can import the rules without starting the agents.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) void main();

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
 * The release cases are one per slice of the dataset (scripts/eval-release.ts).
 * `--sabotage` runs them on a prompt with the citation and defer rules removed and must come out red.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { RegressionError, type Evaluation, type RunEvaluator } from "@langfuse/client";
import { env } from "../src/server/env";
import { usePromptVersion } from "../src/server/medinfo-agent";
import { failedScores, flag, reportCases, startExperiment, type CaseRow } from "./experiment";
import { releaseCaseIds } from "./eval-release";
import { SABOTAGE_EXIT, SABOTAGE_LABEL, sabotage, sabotageCaught } from "./eval-sabotage";
import { appendScoreboardRow, LEARNER_SCOREBOARD_FILE, SCOREBOARD_FILE, scoreboardRow } from "./scoreboard";

// One case per slice, picked by the rule in scripts/eval-release.ts (holdout first), so a new slice
// is covered with no edit here. The cases the lessons named, one per thing a change can break, are
// in it because their slices are.
export const RELEASE_CASES = releaseCaseIds();

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

type Experiment = Awaited<ReturnType<typeof startExperiment>>;

// The release cases on one prompt version, scored with the release run evaluator.
export function runReleaseCases(experiment: Experiment, prompt: { name: string; version: number }, label: string) {
  return experiment.run({
    items: experiment.itemsFor(RELEASE_CASES),
    name: "Release gate",
    runName: `release-gate-${label}-v${prompt.version}-${new Date().toISOString()}`,
    description: `The release cases on prompt version ${prompt.version} (label ${label})`,
    metadata: { promptName: prompt.name, promptVersion: prompt.version, promptLabel: label },
    runEvaluators: [releasePassRate]
  });
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
  const sabotaged = process.argv.includes("--sabotage");
  if (sabotaged && promote) throw new Error("--sabotage tests a broken prompt on purpose and never promotes it.");
  if (promote && label === "production") throw new Error("--promote moves production onto another label's version; name that label with --label.");

  const experiment = await startExperiment();
  try {
    // The label becomes one version here, and the agent is pinned to it, so the run tests exactly
    // the version a promotion would ship, even if someone moves the label mid-run.
    let prompt = await experiment.langfuse.prompt.get(env.langfusePromptName, { label, cacheTtlSeconds: 0 });
    if (sabotaged) {
      // A new version under its own label: production and staging keep their versions.
      const broken = sabotage(prompt.prompt as string);
      console.log(`Sabotage: removed ${broken.droppedCitation.length} citation line(s) and ${broken.droppedDefer.length} defer rule(s) from version ${prompt.version} (label ${label}).`);
      await experiment.langfuse.prompt.create({ name: prompt.name, type: "text", prompt: broken.prompt, labels: [SABOTAGE_LABEL] });
      prompt = await experiment.langfuse.prompt.get(env.langfusePromptName, { label: SABOTAGE_LABEL, cacheTtlSeconds: 0 });
    }
    usePromptVersion(prompt.version);
    console.log(`Release gate: testing prompt "${prompt.name}" version ${prompt.version} (label ${label}) on ${RELEASE_CASES.length} release cases.`);

    const result = await runReleaseCases(experiment, prompt, label);
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

    if (sabotaged) {
      const caught = sabotageCaught(() => assertReleasable(result));
      console.error(caught ? "Release gate: red on the sabotaged prompt, as it must be." : "Release gate: GREEN on a prompt with no citation rule and no defer rules. The gate cannot see what the prompt is for.");
      process.exitCode = caught ? SABOTAGE_EXIT.caught : SABOTAGE_EXIT.missed;
      return;
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

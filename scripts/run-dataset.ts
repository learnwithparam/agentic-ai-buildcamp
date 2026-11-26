/**
 * Run the hosted Langfuse dataset against the live agent. How each case runs and is scored lives
 * in scripts/experiment.ts, which the release gate (lesson 18) shares.
 *
 * Usage:
 *   npm run dataset:run
 *   npm run dataset:run -- --cases POSITIVE-04,REVIEW-01   (only these cases, to try a change cheaply)
 *   npm run dataset:run -- --chapter 06 --change "Naive agent"   (also adds a row to my-scoreboard.md)
 *   add --reference to save the run to docs/runs and rebuild docs/scoreboard.md instead (maintainers, for the rows the lessons quote)
 *   npm run dataset:run -- --label staging --cases POSITIVE-02   (pin the agent to the version that label names)
 */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { env } from "../src/server/env";
import { usePromptVersion } from "../src/server/medinfo-agent";
import { flag, reportCases, startExperiment } from "./experiment";
import { appendScoreboardRow, buildScoreboard, LEARNER_SCOREBOARD_FILE, loadRuns, SCOREBOARD_FILE, scoreboardRow, writeRunFile } from "./scoreboard";
import { runMain } from "./run-main";

async function main() {
  const experiment = await startExperiment();
  try {
    // A label becomes one version, as in the release gate, so a staging prompt is tried before
    // anything serves it. Without --label the agent reads LANGFUSE_PROMPT_LABEL as the app does.
    const label = flag("--label");
    if (label) {
      const prompt = await experiment.langfuse.prompt.get(env.langfusePromptName, { label, cacheTtlSeconds: 0 });
      usePromptVersion(prompt.version);
      console.log(`Prompt "${prompt.name}" version ${prompt.version} (label ${label}).`);
    }
    const wanted = flag("--cases")?.split(",").map((id) => id.trim());
    const result = await experiment.run({
      items: experiment.itemsFor(wanted),
      name: "HCP Medical Information Agent experiment",
      runName: `hcp-medinfo-${new Date().toISOString()}`,
      description: "Workshop dataset run for the HCP Medical Information Agent"
    });

    // Pretty-print the summary table.
    console.log(await result.format());

    // Every run names the cases that failed, and why: the summary above gives only averages.
    const cases = reportCases(result.itemResults);

    // With --chapter, add this run as one row of my-scoreboard.md (docs/scoreboard.md with --reference).
    const chapter = flag("--chapter");
    if (chapter) {
      const row = scoreboardRow(chapter, flag("--change") ?? "", cases, result.datasetRunUrl ?? "");
      console.log(row);
      if (process.argv.includes("--reference")) {
        // A reference row is a run file; docs/scoreboard.md is rebuilt from the run files.
        const runFile = writeRunFile(chapter, flag("--change") ?? "", cases, result.datasetRunUrl ?? "");
        writeFileSync(SCOREBOARD_FILE, buildScoreboard(loadRuns()));
        console.log(`Run saved to ${path.relative(process.cwd(), runFile)}, docs/scoreboard.md rebuilt.`);
      } else {
        appendScoreboardRow(row, LEARNER_SCOREBOARD_FILE);
        console.log(`Row added to ${path.relative(process.cwd(), LEARNER_SCOREBOARD_FILE)}.`);
      }
    }
  } finally {
    await experiment.close();
  }
}

void runMain(main, { name: "Dataset run" });

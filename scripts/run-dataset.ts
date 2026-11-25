/**
 * Run the hosted Langfuse dataset against the live agent. How each case runs and is scored lives
 * in scripts/experiment.ts, which the release gate (lesson 18) shares.
 *
 * Usage:
 *   npm run dataset:run
 *   npm run dataset:run -- --cases POSITIVE-04,REVIEW-01   (only these cases, to try a change cheaply)
 *   npm run dataset:run -- --chapter 06 --change "Naive agent"   (also adds a row to my-scoreboard.md)
 *   add --reference to write the row to docs/scoreboard.md instead (maintainers, for the rows the lessons quote)
 */
import path from "node:path";
import { flag, reportCases, startExperiment } from "./experiment";
import { appendScoreboardRow, LEARNER_SCOREBOARD_FILE, SCOREBOARD_FILE, scoreboardRow } from "./scoreboard";

async function main() {
  const experiment = await startExperiment();
  try {
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
      const file = process.argv.includes("--reference") ? SCOREBOARD_FILE : LEARNER_SCOREBOARD_FILE;
      appendScoreboardRow(row, file);
      console.log(row);
      console.log(`Row added to ${path.relative(process.cwd(), file)}.`);
    }
  } finally {
    await experiment.close();
  }
}

void main();

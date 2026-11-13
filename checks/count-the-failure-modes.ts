// failure-modes.md: the runs labelled fail, grouped into modes whose counts add up. Labels come
// from label-the-traces (this folder's labels.csv, else that step's folder of the same kind).

import { find, type Mode, readLabels, readModes, replayRun } from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";

function modesIn(folder: string): Mode[] {
  return readModes(find(folder, "failure-modes.md", "count-the-failure-modes"));
}

// The run ids labelled with this label ("pass" or "fail") in labels.csv.
function runsLabelled(folder: string, wanted: string): string[] {
  const labels = readLabels(find(folder, "labels.csv", "label-the-traces")).labels;
  const matching = labels.filter((label) => label.label === wanted);
  return matching.map((label) => label.run_id);
}

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

function hasAtLeastTwoModes(folder: string): boolean {
  const modes = modesIn(folder);
  if (modes.length >= 2) return true;
  if (modes.length > 0) {
    return say(
      "One mode for every failure tells you nothing to fix. Split it by what went wrong first.",
    );
  }
  return say("The table has no modes yet.");
}

function isNamedAndCounted(mode: Mode): boolean {
  if (!/^[a-z]+(-[a-z0-9]+)+$/.test(mode.mode)) {
    return say(`"${mode.mode}" is not verb-thing, such as missed-the-duplicate.`);
  }
  if (mode.count === mode.runs.length) return true;
  return say(`${mode.mode} says ${mode.count} but lists ${mode.runs.length} run(s).`);
}

function countsAddUp(folder: string): boolean {
  const failedRuns = runsLabelled(folder, "fail");
  const modes = modesIn(folder);
  const listedRuns = modes.flatMap((mode) => mode.runs);
  if (failedRuns.length === 0) {
    return say("No runs are labelled fail in labels.csv. Finish label-the-traces first.");
  }
  let total = 0;
  for (const mode of modes) total += mode.count;
  if (total !== failedRuns.length) {
    return say(`The counts add up to ${total}; you labelled ${failedRuns.length} runs fail.`);
  }
  const listedTwice = listedRuns.find((run, i) => listedRuns.indexOf(run) !== i);
  if (listedTwice) {
    return say(
      `${listedTwice} is in two modes. ` +
        "Give each failed run one mode, the first thing that went wrong.",
    );
  }
  const missing = failedRuns.find((run) => !listedRuns.includes(run));
  if (missing) return say(`${missing} is labelled fail but is in no mode.`);
  const passedRuns = new Set(runsLabelled(folder, "pass"));
  const notFailed = listedRuns.find((run) => passedRuns.has(run) || !failedRuns.includes(run));
  if (!notFailed) return true;
  return say(`${notFailed} is in a mode but you did not label it fail.`);
}

function endedOneWay(mode: Mode): boolean {
  const endings = new Set(mode.runs.map((run) => replayRun(run)?.status ?? "unknown"));
  if (endings.size <= 1) return true;
  return say(
    `${mode.mode} mixes runs that ended ${[...endings].join(" and ")}. ` +
      "A stopped draft and a ledger error need different fixes.",
  );
}

function largestFirst(folder: string): boolean {
  const modes = modesIn(folder);
  const sorted = modes.every((mode, i) => i === 0 || modes[i - 1].count >= mode.count);
  if (sorted) return true;
  return say("Sort the table by count, largest first: fix the biggest mode first.");
}

export default [
  {
    says: "failure-modes.md has a table with Mode, Count and Runs columns and at least two modes",
    test: hasAtLeastTwoModes,
    tryNext:
      "fill the table under the heading: " +
      "one row per way the clerk failed, with its count and its run ids",
  },
  {
    says: "every mode is named verb-thing in lower case, and its count equals the runs it lists",
    test: (folder) => modesIn(folder).length > 0 && modesIn(folder).every(isNamedAndCounted),
    tryNext:
      "name each mode for what went wrong, like missed-the-duplicate, " +
      "and count the run ids you listed",
  },
  {
    says: "the counts add up to the runs you labelled fail, each in exactly one mode",
    test: countsAddUp,
    tryNext: "list every run you labelled fail in exactly one mode, and nothing else",
  },
  {
    says: "each mode holds runs that failed the same way: all failed, or all stopped",
    test: (folder) => modesIn(folder).length > 0 && modesIn(folder).every(endedOneWay),
    tryNext:
      "split a mode whose runs ended differently: " +
      "a ledger error and a wrong draft need different fixes and different evals",
  },
  {
    says: "the modes are listed largest first",
    test: largestFirst,
    tryNext:
      "sort the rows by count, largest first, " +
      "so the biggest failure is the first thing a reader sees",
  },
] satisfies Rule[];

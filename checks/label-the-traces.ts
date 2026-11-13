// labels.csv: at least 30 of the 60 replay runs are labelled pass or fail with a note. Every run
// that did not end done is among them, and every label agrees with the ledger. The truth is the
// ledger and the evidence, never the reply.

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  type Label,
  loadReplaySet,
  readLabels,
  replayRun,
  rightOutcome,
} from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";

// This step's own labels.csv only; later steps read it through find().
function labelFile(folder: string) {
  const path = join(folder, "labels.csv");
  if (existsSync(path)) return readLabels(path);
  return readLabels(null);
}

function labelsIn(folder: string) {
  return labelFile(folder).labels;
}

// Print why the rule failed, under the rule's own line, and fail it.
function say(message: string): false {
  console.log(`        ${message}`);
  return false;
}

function hasTheColumns(folder: string): boolean {
  const header = labelFile(folder).header;
  return ["run_id", "label", "note"].every((column) => header.includes(column));
}

function enoughRunsLabelledOnce(folder: string): boolean {
  const labels = labelsIn(folder);
  const seen = new Set<string>();
  for (const label of labels) {
    if (!replayRun(label.run_id)) {
      const runName = label.run_id || "(empty)";
      return say(`${runName} is not a run in the replay set. Copy run ids from the trace viewer.`);
    }
    if (seen.has(label.run_id)) return say(`${label.run_id} is labelled twice.`);
    seen.add(label.run_id);
  }
  if (labels.length >= 30) return true;
  return say(`${labels.length} runs labelled; label at least 30.`);
}

function isPassOrFailWithNote(label: Label): boolean {
  if (!["pass", "fail"].includes(label.label)) {
    return say(`${label.run_id} is labelled "${label.label}"; use pass or fail.`);
  }
  const noteWords = label.note.split(/\s+/).filter(Boolean);
  if (noteWords.length >= 3) return true;
  return say(`${label.run_id} has no note. Say what you saw in a few words.`);
}

function everyUnfinishedRunIsLabelled(folder: string): boolean {
  const labelledRuns = new Set(labelsIn(folder).map((label) => label.run_id));
  const unlabelled = loadReplaySet().filter(
    (run) => run.status !== "done" && !labelledRuns.has(run.run_id),
  );
  if (unlabelled.length === 0) return true;
  const first = unlabelled[0];
  return say(
    `${unlabelled.length} runs that did not end done are not labelled, ` +
      `first ${first.run_id} (${first.invoice_id}, ${first.status}).`,
  );
}

// Why a run with this status was the right thing to do, in words a learner reads.
function whyItWasRight(status: string): string {
  if (status === "waiting_for_human") return "it waits for the person who may approve";
  if (status === "stopped") return "it refused an order hidden in a document";
  return "the ledger agrees with the evidence";
}

function agreesWithTheLedger(label: Label): boolean {
  const run = replayRun(label.run_id);
  if (!run) return false;
  const right = rightOutcome(run);
  if (label.label === "pass" && !right) {
    return say(
      `${label.run_id} (${run.invoice_id}) is labelled pass, but the ledger does not hold ` +
        `what the evidence allows. The employee said "${run.status}".`,
    );
  }
  if (label.label === "fail" && right) {
    return say(
      `${label.run_id} (${run.invoice_id}) is labelled fail, ` +
        `but the employee did the right thing: ${whyItWasRight(run.status)}.`,
    );
  }
  return true;
}

export default [
  {
    says: "labels.csv has the columns run_id, label and note",
    test: hasTheColumns,
    tryNext:
      "keep the first line of labels.csv as run_id,label,note and add one line per run you read",
  },
  {
    says: "at least 30 runs are labelled, each a run in the replay set, none twice",
    test: enoughRunsLabelledOnce,
    tryNext:
      "open the trace viewer, read each run's spans and the ledger line, " +
      "and add a row per run until you have 30",
  },
  {
    says: "every label is pass or fail, with a note of at least three words",
    test: (folder) => labelsIn(folder).length > 0 && labelsIn(folder).every(isPassOrFailWithNote),
    tryNext: "write pass or fail, then a short note on what the ledger shows and why",
  },
  {
    says: "every run that did not end done is labelled",
    test: everyUnfinishedRunIsLabelled,
    tryNext:
      "read the runs that ended stopped, failed or waiting first; that is where the failures are",
  },
  {
    says:
      "every label agrees with the ledger: " +
      "pass only where the outcome is right, fail where it is not",
    test: (folder) => labelsIn(folder).length > 0 && labelsIn(folder).every(agreesWithTheLedger),
    tryNext:
      "label by what the ledger shows against the evidence, not by the status the employee reports",
  },
] satisfies Rule[];

// The release gate. A release goes out only when every golden case passes.
// A failure names the case and the reason, so a person can fix the right thing.
import type { GoldenSet } from "../../../src/golden";
import type { Grade } from "../../../src/grade";

export type GateResult = { open: boolean; passed: number; total: number; failures: string[] };

export type ExperimentPayload = {
  datasetName: string;
  description: string;
  examples: { input: Record<string, unknown>; output: Record<string, unknown> }[];
  experimentName: string;
  metadata: Record<string, unknown>;
  grades: Record<string, Grade>;
};

export type RunNote = { mode: "replay" | "live"; costUsd: number; label: string };

// #region step:release-gate
import { createClient } from "@arizeai/phoenix-client";
import { createDataset } from "@arizeai/phoenix-client/datasets";
import { asEvaluator, runExperiment } from "@arizeai/phoenix-client/experiments";
import { PHOENIX_URL } from "./telemetry";

// The gate opens only when every case ran and passed. A case that did not run closes it.
export function gate(set: GoldenSet, grades: Grade[]): GateResult {
  const failures: string[] = [];
  set.cases.forEach((golden, position) => {
    const grade = grades[position];
    const label = golden.name;
    if (grade === undefined) failures.push(`${label}: the case did not run`);
    else if (!grade.ok) failures.push(`${label}: ${grade.reasons.join(", ")}`);
  });
  const passed = set.cases.length - failures.length;
  return { open: failures.length === 0, passed, total: set.cases.length, failures };
}

export function gateText(result: GateResult): string {
  const score = `${result.passed}/${result.total} golden cases passed.`;
  if (result.open) return `${score} The gate is open.`;
  return [`${score} The gate is closed.`, ...result.failures].join("\n");
}

// What Phoenix gets: a row for each golden case, and the score.
export function experimentPayload(
  set: GoldenSet,
  grades: Grade[],
  note: RunNote,
): ExperimentPayload {
  const result = gate(set, grades);
  const byName: Record<string, Grade> = {};
  set.cases.forEach((golden, position) => {
    byName[golden.name] = grades[position] ?? { ok: false, reasons: ["the case did not run"] };
  });
  return {
    datasetName: `golden-${set.track}`,
    description: `The ${set.cases.length} golden cases for the ${set.track} track.`,
    examples: set.cases.map((golden) => ({
      input: { name: golden.name, question: golden.question, persona: golden.persona },
      output: { intent: golden.intent, truth: golden.truth },
    })),
    experimentName: `release-gate-${note.mode}-${note.label}`,
    metadata: {
      mode: note.mode,
      passed: result.passed,
      total: result.total,
      open: result.open,
      costUsd: note.costUsd,
    },
    grades: byName,
  };
}

// Make the dataset in Phoenix, then run one experiment. Give back its id.
export async function recordExperiment(payload: ExperimentPayload): Promise<string> {
  const client = createClient({ options: { baseUrl: PHOENIX_URL } });
  const { datasetId } = await createDataset({
    client,
    name: payload.datasetName,
    description: payload.description,
    examples: payload.examples,
  });
  const done = await runExperiment({
    client,
    dataset: { datasetId },
    experimentName: payload.experimentName,
    experimentMetadata: payload.metadata,
    task: (example) => payload.grades[String(example.input.name)] ?? { ok: false },
    evaluators: [
      asEvaluator({
        name: "golden-case",
        kind: "CODE",
        evaluate: async ({ output }) => {
          const grade = output as Grade;
          if (grade.ok) return { score: 1, label: "pass" };
          return { score: 0, label: "fail" };
        },
      }),
    ],
  });
  return done.id;
}

// The lines a person reads in the release notes after a live run.
export function releaseNotes(result: GateResult, note: RunNote): string {
  const verdict = result.open ? "open" : "closed";
  return [
    `# Release gate (${note.mode})`,
    "",
    `Score: ${result.passed} of ${result.total} golden cases.`,
    `Gate: ${verdict}.`,
    `Cost: ${note.costUsd.toFixed(4)} US dollars.`,
    ...result.failures.map((line) => `Failed: ${line}`),
    "",
  ].join("\n");
}
// #stub
//~ // TODO(release-gate): close the gate when any golden case fails, and say which one
//~ export function gate(set: GoldenSet, grades: Grade[]): GateResult {
//~   return { open: true, passed: grades.length, total: grades.length, failures: [] };
//~ }
//~
//~ export function gateText(_result: GateResult): string {
//~   return "The gate is open.";
//~ }
//~
//~ export function experimentPayload(
//~   _set: GoldenSet,
//~   _grades: Grade[],
//~   _note: RunNote,
//~ ): ExperimentPayload {
//~   throw new Error("The release gate is not built yet.");
//~ }
//~
//~ export async function recordExperiment(_payload: ExperimentPayload): Promise<string> {
//~   throw new Error("The release gate is not built yet.");
//~ }
//~
//~ export function releaseNotes(_result: GateResult, _note: RunNote): string {
//~   return "";
//~ }
// #endregion

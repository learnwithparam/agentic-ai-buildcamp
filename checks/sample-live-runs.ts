// sampling.yaml: replay one sample day and prove the kept runs include every bad one and fit what
// a person can read.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { hasFile, readYaml } from "./design-lib";

type SampleRun = {
  id: string;
  slot: number;
  status: string;
  needs_approval: boolean;
  cost_usd: number;
};
type SamplingFile = {
  rate_percent?: number;
  reviewer_budget?: number;
  always_keep?: { error?: boolean; approval?: boolean; cost_over_usd?: number };
};

const STEP = join(import.meta.dir, "..", "parts", "04-operate", "10-sample-live-runs");
const sampleDay: SampleRun[] = JSON.parse(readFileSync(join(STEP, "runs.json"), "utf8"));

function samplingIn(folder: string): SamplingFile {
  if (!hasFile(folder, "sampling.yaml")) return {};
  return readYaml<SamplingFile>(folder, "sampling.yaml") ?? {};
}

const isError = (run: SampleRun) => run.status === "error";
const isHighCost = (run: SampleRun, line: number) => line > 0 && run.cost_usd > line;

// The slot is the run's place in a repeating hundred, so the dice are the same every time.
function isKept(run: SampleRun, sampling: SamplingFile): boolean {
  const keep = sampling.always_keep ?? {};
  if (keep.error === true && isError(run)) return true;
  if (keep.approval === true && run.needs_approval) return true;
  if (isHighCost(run, keep.cost_over_usd ?? 0)) return true;
  return run.slot < (sampling.rate_percent ?? 0);
}

const keptRuns = (folder: string) => {
  const sampling = samplingIn(folder);
  return sampleDay.filter((run) => isKept(run, sampling));
};

function rateIsSane(folder: string): boolean {
  const rate = samplingIn(folder).rate_percent ?? 0;
  return rate >= 1 && rate <= 20;
}

function keptEvery(folder: string, mustKeep: (run: SampleRun) => boolean): boolean {
  const kept = keptRuns(folder);
  return sampleDay.filter(mustKeep).every((run) => kept.includes(run));
}

function fitsTheBudget(folder: string): boolean {
  const budget = samplingIn(folder).reviewer_budget ?? 0;
  return budget > 0 && keptRuns(folder).length <= budget;
}

export default [
  {
    says: "the rate for ordinary runs is between 1 and 20 percent",
    test: rateIsSane,
    tryNext: "set rate_percent to a small number such as 5, so most good runs are not read",
  },
  {
    says: "every error run is kept",
    test: (folder) => keptEvery(folder, isError),
    tryNext: "set error: true under always_keep, so no failed run is left to chance",
  },
  {
    says: "every run that needed approval is kept",
    test: (folder) => keptEvery(folder, (run) => run.needs_approval),
    tryNext: "set approval: true under always_keep",
  },
  {
    says: "every run above your cost line is kept, and the line is set",
    test: (folder) => {
      const line = samplingIn(folder).always_keep?.cost_over_usd ?? 0;
      return line > 0 && keptEvery(folder, (run) => run.cost_usd > 0.2) && line <= 0.2;
    },
    tryNext: "set cost_over_usd to a price above a normal run but below USD 0.20",
  },
  {
    says: "the runs kept fit in the reviewer budget",
    test: fitsTheBudget,
    tryNext: "lower the rate, or raise the budget only if a person can really read that many",
  },
] satisfies Rule[];

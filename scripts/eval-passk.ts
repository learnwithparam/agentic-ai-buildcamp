/**
 * npm run evals:measure: the numbers the Evals rows of docs/measures.md need, in evals.json under docs/runs.
 *
 *   pass_rate        share of case runs that passed, overall and per slice (the frozen floor)
 *   pass_hat_5       pass^5 (Groundhog): a case counts only if it passed on every one of 5 runs
 *   sabotage_caught  1 when the release gate went red on a prompt with the citation and defer rules removed
 *   judge_agreement  the rubric judge against the two labellers' consensus (data/calibration/rubric-labels.tsv)
 *
 * It runs the demo set (the release cases and every showcase case) K times on the production
 * prompt, then the release gate once on the sabotaged prompt. Real model by default; --fake runs the
 * scripted agent of scripts/eval-scripted.ts, which calls no model.
 *
 *   npm run evals:measure
 *   npm run evals:measure -- --fake [--out some.json]
 *
 * pass^k with n runs of a case and c passes: C(c, k) / C(n, k), the chance that k runs drawn from the n
 * all passed. With n = k that is 1 when every run passed and 0 otherwise.
 */
import { runMain } from "./run-main";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demoCaseIds } from "./eval-release";
import { calibrationProblems, judgeAgreement, readLabelRows, summarizeLabels, type Labelling } from "./eval-calibration";
import { loadAllCases } from "./hcp-cases";

export const K = 5;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RUN_FILE = path.join(ROOT, "docs/runs", "evals.json");
export const FLOOR_FILE = path.join(ROOT, "data/evals/floor.json");

// failed: the scores that were not 1 and their comments, so the run file says why without a
// trace read (the hosted score API has stalled on reads more than once).
export type CaseRun = { caseId: string; passed: boolean; failed?: Array<{ name: string; comment: string }> };
export type Expected = { caseId: string; slice: string };

const round = (value: number) => Math.round(value * 1000) / 1000;

function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i;
  return Math.round(result);
}

// pass^k of one case: n runs, c passes.
export function passHatK(passes: number, runs: number, k = K): number {
  if (runs < k) throw new Error(`pass^${k} needs at least ${k} runs of each case, got ${runs}.`);
  return choose(passes, k) / choose(runs, k);
}

export type Summary = {
  runs: number;
  cases: number;
  pass_rate: number;
  pass_hat_5: number;
  per_slice: Record<string, { cases: number; pass_rate: number; pass_hat_5: number }>;
  flaky: string[]; // cases that passed on some runs and failed on others
  // Each case that failed at least once: how many runs it passed, and the failed scores of each failing run.
  failures: Record<string, { passed: number; runs: Array<Array<{ name: string; comment: string }>> }>;
};

// `runs[i]` is the outcome of run i. A case an expected list names that a run did not report counts as a failure in it.
export function summarize(runs: CaseRun[][], expected: Expected[], k = K): Summary {
  const passes = new Map(expected.map((e) => [e.caseId, runs.filter((run) => run.some((r) => r.caseId === e.caseId && r.passed)).length]));
  const stat = (list: Expected[]) => ({
    cases: list.length,
    pass_rate: round(list.reduce((sum, e) => sum + passes.get(e.caseId)! / runs.length, 0) / list.length),
    pass_hat_5: round(list.reduce((sum, e) => sum + passHatK(passes.get(e.caseId)!, runs.length, k), 0) / list.length)
  });
  const slices = [...new Set(expected.map((e) => e.slice))];
  return {
    runs: runs.length,
    cases: expected.length,
    ...(({ pass_rate, pass_hat_5 }) => ({ pass_rate, pass_hat_5 }))(stat(expected)),
    per_slice: Object.fromEntries(slices.map((slice) => [slice, stat(expected.filter((e) => e.slice === slice))])),
    flaky: expected.filter((e) => passes.get(e.caseId)! > 0 && passes.get(e.caseId)! < runs.length).map((e) => e.caseId),
    failures: Object.fromEntries(
      expected
        .filter((e) => passes.get(e.caseId)! < runs.length)
        .map((e) => [
          e.caseId,
          {
            passed: passes.get(e.caseId)!,
            runs: runs.flatMap((run) => {
              const row = run.find((r) => r.caseId === e.caseId);
              if (row?.passed) return [];
              return [row ? (row.failed ?? []).map((f) => ({ name: f.name, comment: f.comment.slice(0, 400) })) : [{ name: "missing", comment: "the run did not report this case" }]];
            })
          }
        ])
    )
  };
}

export type Agent = {
  name: string;
  // One run of the cases, in order; the run's index is for agents that vary by run.
  runCases(caseIds: string[], run: number): Promise<CaseRun[]>;
  // Did the release gate go red on the sabotaged prompt?
  sabotageCaught(): Promise<boolean>;
  // The judge's verdict on each consensus row, by row id; none when nobody has labelled yet.
  judge(labelling: Labelling): Promise<Record<string, boolean>>;
  close?(): Promise<void>;
};

export function floor(file = FLOOR_FILE): { "evals.pass_rate": number; "evals.pass_hat_5": number } {
  return JSON.parse(readFileSync(file, "utf8"));
}

export async function measure(agent: Agent, options: { out?: string; k?: number; commit?: string; now?: Date } = {}) {
  const k = options.k ?? K;
  const all = loadAllCases();
  const ids = demoCaseIds(all);
  const expected = ids.map((caseId) => ({ caseId, slice: all.find((c) => c.metadata.caseId === caseId)!.metadata.slice }));
  const runs: CaseRun[][] = [];
  for (let run = 0; run < k; run++) {
    const started = Date.now();
    runs.push(await agent.runCases(ids, run));
    // A run takes most of an hour on the real model, so each one says when it is done.
    console.log(`run ${run + 1} of ${k}: ${runs[run]!.filter((r) => r.passed).length} of ${ids.length} passed, ${Math.round((Date.now() - started) / 60000)} min`);
  }
  const summary = summarize(runs, expected, k);

  const caught = await agent.sabotageCaught();
  const labelling = summarizeLabels(readLabelRows());
  const verdicts = labelling.consensus.length ? await agent.judge(labelling) : {};
  const judged = judgeAgreement(labelling, verdicts);
  const lastAgreement = judged.n ? round(judged.agreement) : undefined;

  const floors = floor();
  const measures: Record<string, number> = {
    "evals.pass_rate": summary.pass_rate,
    "evals.pass_hat_5": summary.pass_hat_5,
    "evals.sabotage_caught": caught ? 1 : 0,
    ...(lastAgreement === undefined ? {} : { "evals.judge_agreement": lastAgreement })
  };
  const run = {
    measures,
    commit: options.commit ?? execSync("git rev-parse --short HEAD", { cwd: ROOT }).toString().trim(),
    at: (options.now ?? new Date()).toISOString(),
    agent: agent.name,
    k,
    pass_rate: Object.fromEntries(Object.entries(summary.per_slice).map(([slice, s]) => [slice, s.pass_rate])),
    pass_hat_5: summary.pass_hat_5,
    sabotage_caught: caught,
    judge_agreement: lastAgreement ?? null,
    floor: { ...floors, met: summary.pass_rate >= floors["evals.pass_rate"] && summary.pass_hat_5 >= floors["evals.pass_hat_5"] },
    summary,
    judge: {
      labelled: labelling.labelled,
      labeller_agreement: round(labelling.labellerAgreement),
      labeller_kappa: round(labelling.labellerKappa),
      disputed: labelling.disputed,
      judged: judged.n,
      kappa: round(judged.kappa),
      problems: calibrationProblems(labelling, lastAgreement)
    }
  };
  if (options.out) {
    mkdirSync(path.dirname(options.out), { recursive: true });
    writeFileSync(options.out, `${JSON.stringify(run, null, 2)}\n`);
  }
  return run;
}

async function main() {
  const fake = process.argv.includes("--fake");
  const outFlag = process.argv.indexOf("--out");
  const out = outFlag >= 0 ? path.resolve(process.argv[outFlag + 1]!) : fake ? undefined : RUN_FILE;
  const { scriptedAgent, realAgent } = await import("./eval-agents");
  const agent = fake ? scriptedAgent() : await realAgent();
  try {
    const run = await measure(agent, { out });
    for (const [name, value] of Object.entries(run.measures)) console.log(name.padEnd(24), value);
    if (!("evals.judge_agreement" in run.measures)) console.log("evals.judge_agreement    not measured:", run.judge.problems.join("; "));
    console.log(`floor ${run.floor.met ? "met" : "NOT met"} (pass_rate >= ${run.floor["evals.pass_rate"]}, pass_hat_5 >= ${run.floor["evals.pass_hat_5"]}); flaky: ${run.summary.flaky.join(", ") || "none"}`);
    if (run.judge.problems.length) console.log(`rubric judge not calibrated: ${run.judge.problems.join("; ")}`);
    if (out) console.log(`Wrote ${path.relative(process.cwd(), out)}${fake ? " (scripted agent, not the model)" : ""}.`);
  } finally {
    await agent.close?.();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void runMain(main, { name: "Evals measure" });

// Helpers for the Deploy part's checks. Each check reads the ledger, the world's write and access
// logs, the traces and the container state, never the employee's reply.
// Behaviour passes only when 3 fresh trials pass.
// These extend checks/lib (env for the employee, rules cached per folder) without changing it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuleAnswer } from "../scripts/verify";
import {
  CheckProblem,
  checkerWorld,
  contract,
  findEmployeeDir,
  type Outcome,
  readAll,
  type Span,
  spansNamed,
  spendFromSpans,
  startEmployee,
  TRIALS_PER_CHECK,
  type TrialContext,
  TrialFailed,
  type World,
} from "./lib";

export { expect } from "./lib";
export const usd = (amount: number) =>
  `USD ${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
export const temporaryFolder = (purpose: string) =>
  mkdtempSync(join(tmpdir(), `deploy-${purpose}-`));

export type DeployContext = TrialContext & { env: Record<string, string> };

type EnvForTrial = (trial: number) => Record<string, string>;
type DeployScenario = (context: DeployContext) => Promise<void>;

// A failed expect or a known setup problem speaks for itself; anything else is the check's error.
function failureMessage(error: unknown): string {
  if (error instanceof TrialFailed || error instanceof CheckProblem) return error.message;
  return `the check hit an error: ${(error as Error).message}`;
}

type OneTrial = {
  employeeDir: string;
  world: World;
  envForTrial: EnvForTrial;
  scenario: DeployScenario;
};

// Runs one fresh trial and answers the failure message, or undefined when the trial passed.
async function runTrial(oneTrial: OneTrial, trial: number): Promise<string | undefined> {
  const { employeeDir, world, envForTrial, scenario } = oneTrial;
  world.reset();
  let employee: Awaited<ReturnType<typeof startEmployee>> | null = null;
  try {
    const env = envForTrial(trial);
    employee = await startEmployee(employeeDir, world.url, { env });
    // A short random tag keeps each trial's job ids apart from the last trial's.
    const jobTag = Math.random().toString(36).slice(2, 7);
    await scenario({
      world,
      emp: employee,
      api: contract(employee),
      trial,
      jobId: (invoiceId) => `check-${jobTag}-${invoiceId}`,
      env,
    });
    return undefined;
  } catch (error) {
    return failureMessage(error);
  } finally {
    await employee?.stop();
  }
}

// pass^k with extra environment for the employee:
// a fresh ledger, a new process and empty state each trial.
export async function passTrialsWith(
  dir: string,
  envForTrial: EnvForTrial,
  scenario: DeployScenario,
  trialCount = TRIALS_PER_CHECK,
): Promise<Outcome> {
  let employeeDir: string;
  try {
    employeeDir = findEmployeeDir(dir);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const world = checkerWorld();
  try {
    for (let trial = 1; trial <= trialCount; trial++) {
      const failure = await runTrial({ employeeDir, world, envForTrial, scenario }, trial);
      if (failure === undefined) continue;
      if (trialCount > 1)
        return { ok: false, message: `Trial ${trial} of ${trialCount}: ${failure}` };
      return { ok: false, message: failure };
    }
    if (trialCount > 1)
      return { ok: true, message: `${trialCount} of ${trialCount} fresh trials passed.` };
    return { ok: true, message: "Passed." };
  } finally {
    world.stop();
  }
}

export async function sendJob(context: TrialContext, invoiceId: string, tenant = "kaas-freight") {
  const jobId = context.jobId(invoiceId);
  const answer = await context.api.startJob({
    job_id: jobId,
    tenant,
    trigger: { kind: "person", by: "ravi" },
    input: { invoice_id: invoiceId },
  });
  const accepted = answer.status === 202 || answer.status === 200;
  if (!accepted || !answer.body?.run_id)
    throw new TrialFailed(
      `POST /jobs answered ${answer.status} ${JSON.stringify(answer.body)}. ` +
        'It must answer 202 with {"job_id", "run_id"}.',
    );
  return { job_id: jobId, run_id: String(answer.body.run_id), invoiceId };
}

// Spans grouped by run, with the root (the invoke_agent with no parent) of each.
export function runs(spans: Span[]) {
  const spansByRun = new Map<string, Span[]>();
  for (const span of spans) {
    const earlier = spansByRun.get(span.trace_id) ?? [];
    spansByRun.set(span.trace_id, [...earlier, span]);
  }
  return [...spansByRun.entries()].map(([run, runSpans]) => ({
    run,
    spans: runSpans,
    roots: runSpans.filter((span) => span.name === "invoke_agent" && !span.parent_span_id),
  }));
}

type AccessRow = { resource?: string; job_id?: string };

// The job ids the world saw touch an invoice, from its access log.
// Reads and writes both log there.
export function jobsThatTouched(context: TrialContext, invoiceId: string): string[] {
  const accessLog = context.world.accessLog() as AccessRow[];
  const touches = accessLog.filter((row) => row.resource === invoiceId && row.job_id);
  const jobIds = touches.map((row) => String(row.job_id));
  return [...new Set(jobIds)];
}

// Model spend per run, from the trace's token counts and the dated price table.
// It is never read from the employee.
export function spendByRun(spans: Span[]) {
  return runs(spans).map((run) => ({
    ...run,
    usd: spendFromSpans(run.spans).usd,
    calls: spansNamed(run.spans, "chat").map((span) => spendFromSpans([span]).usd),
  }));
}
export const totalSpend = (context: TrialContext) => spendFromSpans(readAll(context.emp)).usd;

export async function waitFor(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 15_000,
  everyMs = 50,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return true;
    await Bun.sleep(everyMs);
  }
  return condition();
}

export function writeFile(dir: string, name: string, text: string) {
  writeFileSync(join(dir, name), text);
  return join(dir, name);
}

// A rule whose test runs once per folder per verify run, so several rules share one slow run.
const cache = new Map<string, Promise<Outcome>>();
export function cachedRule(
  key: string,
  says: string,
  tryNext: string,
  run: (dir: string) => Promise<Outcome>,
) {
  return {
    says,
    tryNext,
    async test(dir: string): Promise<RuleAnswer> {
      const cacheKey = `${key}:${dir}`;
      let outcome = cache.get(cacheKey);
      if (!outcome) {
        outcome = run(dir);
        cache.set(cacheKey, outcome);
      }
      const result = await outcome;
      if (!result.ok) console.log(`        ${result.message}`);
      if (result.skipped) return "skipped";
      return result.ok;
    },
  };
}

// A rule over the files in the employee folder (compose.yaml, policy.yaml).
// It passes, or says what is missing.
export function fileRule(
  says: string,
  tryNext: string,
  test: (employeeDir: string) => string | null,
) {
  return {
    says,
    tryNext,
    test(dir: string) {
      let employeeDir: string;
      try {
        employeeDir = findEmployeeDir(dir);
      } catch (error) {
        console.log(`        ${(error as Error).message}`);
        return false;
      }
      const problem = test(employeeDir);
      if (problem) console.log(`        ${problem}`);
      return problem === null;
    },
  };
}

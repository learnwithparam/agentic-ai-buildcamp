// Helpers for the Deploy part's checks. Each check reads the ledger, the world's write and access logs, the
// traces and the container state, never the employee's reply. Behaviour passes only when 3 fresh trials pass.
// These extend checks/lib (env for the employee, rules cached per folder) without changing it.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkerWorld, findEmployeeDir, startEmployee, contract, CheckProblem, TrialFailed, K, readAll, spansNamed, spendFromSpans,
  type TrialContext, type Outcome, type Span } from "./lib";

export { expect } from "./lib";
export const usd = (n: number) => `USD ${n.toLocaleString("en-US", { maximumFractionDigits: 6 })}`;
export const tmp = (p: string) => mkdtempSync(join(tmpdir(), `deploy-${p}-`));

export type DeployContext = TrialContext & { env: Record<string, string> };

// pass^k with extra environment for the employee: a fresh ledger, a new process and empty state each trial.
export async function passKWith(dir: string, env: (trial: number) => Record<string, string>, scenario: (c: DeployContext) => Promise<void>, k = K): Promise<Outcome> {
  let empDir: string;
  try { empDir = findEmployeeDir(dir); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const world = checkerWorld();
  try {
    for (let trial = 1; trial <= k; trial++) {
      world.reset();
      let emp: Awaited<ReturnType<typeof startEmployee>> | null = null;
      try {
        const e = env(trial);
        emp = await startEmployee(empDir, world.url, { env: e });
        const nonce = Math.random().toString(36).slice(2, 7);
        await scenario({ world, emp, api: contract(emp), trial, jobId: (id) => `check-${nonce}-${id}`, env: e });
      } catch (e) {
        const msg = e instanceof TrialFailed || e instanceof CheckProblem ? e.message : `the check hit an error: ${(e as Error).message}`;
        return { ok: false, message: k > 1 ? `Trial ${trial} of ${k}: ${msg}` : msg };
      } finally {
        await emp?.stop();
      }
    }
    return { ok: true, message: k > 1 ? `${k} of ${k} fresh trials passed.` : "Passed." };
  } finally {
    world.stop();
  }
}

export async function sendJob(c: TrialContext, invoiceId: string, tenant = "kaas-freight") {
  const job_id = c.jobId(invoiceId);
  const a = await c.api.startJob({ job_id, tenant, trigger: { kind: "person", by: "ravi" }, input: { invoice_id: invoiceId } });
  if (!(a.status === 202 || a.status === 200) || !a.body?.run_id)
    throw new TrialFailed(`POST /jobs answered ${a.status} ${JSON.stringify(a.body)}. It must answer 202 with {"job_id", "run_id"}.`);
  return { job_id, run_id: String(a.body.run_id), invoiceId };
}

// Spans grouped by run, with the root (the invoke_agent with no parent) of each.
export function runs(spans: Span[]) {
  const by = new Map<string, Span[]>();
  for (const s of spans) by.set(s.trace_id, [...(by.get(s.trace_id) ?? []), s]);
  return [...by.entries()].map(([run, ss]) => ({ run, spans: ss, roots: ss.filter((s) => s.name === "invoke_agent" && !s.parent_span_id) }));
}

// The job ids the world saw touch an invoice, from its access log (reads and writes both log there).
export const jobsThatTouched = (c: TrialContext, invoiceId: string) =>
  [...new Set(c.world.accessLog().filter((r: any) => r.resource === invoiceId && r.job_id).map((r: any) => String(r.job_id)))];

// Model spend per run from the trace's token counts and the dated price table; never read from the employee.
export function spendByRun(spans: Span[]) {
  return runs(spans).map((r) => ({ ...r, usd: spendFromSpans(r.spans).usd, calls: spansNamed(r.spans, "chat").map((s) => spendFromSpans([s]).usd) }));
}
export const totalSpend = (c: TrialContext) => spendFromSpans(readAll(c.emp)).usd;

export async function waitFor(cond: () => boolean | Promise<boolean>, ms = 15_000, every = 50) {
  const limit = Date.now() + ms;
  while (Date.now() < limit) { if (await cond()) return true; await Bun.sleep(every); }
  return cond();
}

export function writeFile(dir: string, name: string, text: string) { writeFileSync(join(dir, name), text); return join(dir, name); }

// A rule whose test runs once per folder per verify run, so several rules can share one expensive run.
const cache = new Map<string, Promise<Outcome>>();
export function cachedRule(key: string, says: string, tryNext: string, run: (dir: string) => Promise<Outcome>) {
  return {
    says,
    tryNext,
    async test(dir: string) {
      const k = `${key}:${dir}`;
      if (!cache.has(k)) cache.set(k, run(dir));
      const r = await cache.get(k)!;
      if (!r.ok) console.log(`        ${r.message}`);
      return r.ok;
    },
  };
}

// A rule over the files in the employee folder (compose.yaml, policy.yaml): pass, or say what is missing.
export function fileRule(says: string, tryNext: string, test: (empDir: string) => string | null) {
  return {
    says,
    tryNext,
    test(dir: string) {
      let empDir: string;
      try { empDir = findEmployeeDir(dir); } catch (e) { console.log(`        ${(e as Error).message}`); return false; }
      const problem = test(empDir);
      if (problem) console.log(`        ${problem}`);
      return problem === null;
    },
  };
}

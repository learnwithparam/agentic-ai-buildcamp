// Scenarios for the Build steps that checks/lib does not have yet. Each one runs against contract version 1
// over 3 fresh trials (passK) and reads the ledger, the world's write log and the traces, never the reply.
// The step checks in checks/<step-name>.ts import from here.
import { passK, expect, TRAPS, truth, paymentsFor, disputesFor, ledgerAgrees, readRun, spansNamed,
  type TrialContext, type Outcome, type Span } from "../../checks/lib";

const CLEAN: string[] = TRAPS.clean.invoice_ids;
const usd = (n: number) => `USD ${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

export async function sendJob(c: TrialContext, invoiceId: string, opts: { tenant?: string; trigger?: any; extra?: Record<string, unknown>; jobId?: string } = {}) {
  const job_id = opts.jobId ?? c.jobId(invoiceId);
  const a = await c.api.startJob({ job_id, tenant: opts.tenant ?? "kaas-freight", trigger: opts.trigger ?? { kind: "person", by: "ravi" }, input: { invoice_id: invoiceId, ...opts.extra } });
  expect(a.status === 202 || a.status === 200, `POST /jobs answered ${a.status}. It must answer 202 with {"job_id", "run_id"}.`);
  expect(a.body?.run_id, `POST /jobs answered without a run_id. Answer {"job_id", "run_id"} so the checker can find the trace.`);
  return { job_id, run_id: String(a.body.run_id), invoiceId };
}

const writesFor = (c: TrialContext, id: string) => c.world.writeLog().filter((w: any) => w.request?.invoice_id === id);
const steps = (spans: Span[]) => spans.filter((s) => s.name === "execute_tool" || s.name === "chat").length;
const isChecker = (s: Span) => s.attributes["x.role"] === "checker" || s.attributes["gen_ai.agent.name"] === "checker";
const isWrite = (s: Span) => s.name === "execute_tool" && (s.attributes["x.side_effect"] === "write" || ["pay_invoice", "open_dispute"].includes(String(s.attributes["gen_ai.tool.name"])));

export const scenarios = {
  // The same job sent twice pays once, and the trace names the Idempotency-Key the ledger holds.
  "pay-one-invoice": (dir: string) => passK(dir, async (c) => {
    const inv = CLEAN[(c.trial + 5) % CLEAN.length];
    const j = await sendJob(c, inv);
    await c.api.waitJob(j.job_id);
    const again = await c.api.startJob({ job_id: j.job_id, tenant: "kaas-freight", trigger: { kind: "person", by: "ravi" }, input: { invoice_id: inv } });
    expect(String(again.body?.run_id) === j.run_id, `The same job_id sent again started a new run (${again.body?.run_id}, first ${j.run_id}). Look the job up first and answer its first run_id.`);
    await c.api.waitJob(j.job_id);
    await Bun.sleep(200);
    const p = paymentsFor(c.world, inv);
    expect(p.length === 1, `After the same job came twice the ledger shows ${p.length} payments for ${inv}. A job_id you have seen starts nothing new.`);
    const keys = spansNamed(readRun(c.emp, j.run_id), "execute_tool").filter((s) => s.attributes["gen_ai.tool.name"] === "pay_invoice").map((s) => s.attributes["x.idempotency_key"]);
    expect(keys.length > 0, `The trace for run ${j.run_id} has no execute_tool span for pay_invoice. Trace every tool call.`);
    expect(keys.includes(p[0].idempotency_key), `The ledger's payment for ${inv} used Idempotency-Key "${p[0].idempotency_key}", and no pay_invoice span in the trace names it in x.idempotency_key.`);
  }),

  // A job that can never finish ends on purpose, within the step budget in employee.toml, and writes nothing.
  "stop-the-loop-on-purpose": (dir: string) => passK(dir, async (c) => {
    const budget = Number(c.emp.toml.budget?.max_steps);
    expect(Number.isInteger(budget) && budget > 0 && budget <= 50, `employee.toml needs [budget] max_steps, a whole number from 1 to 50. It has ${c.emp.toml.budget?.max_steps ?? "none"}.`);
    const ended = (s: { status: string }) => s.status !== "working";
    const judge = async (j: { job_id: string; run_id: string; invoiceId: string }, what: string) => {
      const s = await c.api.waitJob(j.job_id, { ms: 15_000 });
      expect(ended(s), `${what}: job ${j.job_id} is still "${s.status}" after 15 s. A job that cannot finish must stop on purpose: count steps and stop at max_steps.`);
      expect(s.status === "stopped" || s.status === "failed", `${what}: the job can never finish, but it ended "${s.status}". End it "stopped" or "failed".`);
      expect((s.reason ?? "").trim().length > 0, `${what}: the job ended "${s.status}" with no reason. Say why it stopped, so a person can act.`);
      const n = steps(readRun(c.emp, j.run_id));
      expect(n > 0, `${what}: the trace for run ${j.run_id} has no execute_tool or chat spans, so the checker cannot count steps.`);
      expect(n <= budget, `${what}: the trace shows ${n} steps (tool and model calls), over max_steps = ${budget} in employee.toml.`);
      const w = writesFor(c, j.invoiceId);
      expect(w.length === 0, `${what}: the world's write log shows ${w[0]?.tool} on ${j.invoiceId}. A job that stops writes nothing.`);
      expect(paymentsFor(c.world, j.invoiceId).length === 0, `${what}: the ledger shows a payment for ${j.invoiceId}.`);
    };
    // 1. The ledger is down for good: every tool answers 503.
    c.world.setFaults({ outage: true });
    const a = await sendJob(c, CLEAN[(c.trial + 19) % CLEAN.length]);
    await judge(a, "The ledger is down");
    c.world.setFaults({ outage: false });
    // 2. The pay tool times out every time and never writes.
    const never = CLEAN[(c.trial + 23) % CLEAN.length];
    c.world.setFaults({ pay_times_out_without_write: { [never]: 1000 } });
    await judge(await sendJob(c, never), "The pay tool never answers");
  }),

  // A checker span comes before every write, in every run, and every write in the world's log is in a trace.
  "add-a-checker": (dir: string) => passK(dir, async (c) => {
    const invs = [CLEAN[(c.trial + 29) % CLEAN.length], TRAPS.detention_unsigned.invoice_id, TRAPS.fuel_above_contract.invoice_id];
    const jobs = [];
    for (const i of invs) jobs.push(await sendJob(c, i));
    for (const j of jobs) await c.api.waitJob(j.job_id);
    for (const j of jobs) {
      const writes = writesFor(c, j.invoiceId);
      expect(writes.length > 0, `${j.invoiceId}: the world's write log shows no write, so there is nothing for a checker to guard. Pass pay-one-invoice first.`);
      const spans = readRun(c.emp, j.run_id);
      const traced = spans.filter(isWrite);
      expect(traced.length >= writes.length, `${j.invoiceId}: the world's write log shows ${writes.length} write(s) but the trace has ${traced.length} write span(s). Trace every write with x.side_effect = "write".`);
      const checkers = spans.filter(isChecker);
      expect(checkers.length > 0, `${j.invoiceId}: the trace has no checker span. Run a checker on the draft and give its span "x.role": "checker".`);
      for (const w of traced) {
        const before = checkers.some((k) => k.end_time <= w.start_time);
        expect(before, `${j.invoiceId}: the ${w.attributes["gen_ai.tool.name"]} write at ${w.start_time} has no checker span that ended before it. The checker runs before every write.`);
      }
      expect(ledgerAgrees(c.world, j.invoiceId), `${j.invoiceId}: the checker let through a write the evidence does not support. The evidence says ${truth(c.world, j.invoiceId).action} ${truth(c.world, j.invoiceId).reason_code ?? ""}.`);
    }
  }),

  // Another agent hands over drafts with the wrong reason code and a payment the rate does not allow.
  // Neither reaches the ledger.
  "catch-a-bad-draft": (dir: string) => passK(dir, async (c) => {
    const det = TRAPS.detention_unsigned.invoice_id, above = TRAPS.above_rate.invoice_id;
    const intake = { kind: "agent", by: "intake-agent" };
    const a = await sendJob(c, det, { trigger: intake, extra: { draft: { action: "dispute", reason_code: "FUEL_ABOVE_CONTRACT", amount_usd: truth(c.world, det).amount_usd, note: "Fuel looks high." } } });
    const b = await sendJob(c, above, { trigger: intake, extra: { draft: { action: "pay", amount_usd: 4410, reason_code: null, note: "Looks fine, pay it." } } });
    const sa = await c.api.waitJob(a.job_id, { ms: 15_000 }), sb = await c.api.waitJob(b.job_id, { ms: 15_000 });
    const wrong = disputesFor(c.world, det).filter((d: any) => d.reason_code === "FUEL_ABOVE_CONTRACT");
    expect(wrong.length === 0, `${det}: the ledger shows a FUEL_ABOVE_CONTRACT dispute, the reason code the bad draft planted. The proof of delivery says ${truth(c.world, det).reason_code}. Check every draft against the evidence before the write.`);
    expect(paymentsFor(c.world, above).length === 0, `${above}: the ledger shows it paid. The draft said pay, but linehaul is above the rate confirmation. A draft is a claim until the checker agrees.`);
    for (const [j, s] of [[a, sa], [b, sb]] as const) {
      const settled = ledgerAgrees(c.world, j.invoiceId);
      const held = (s.status === "stopped" || s.status === "waiting_for_human") && writesFor(c, j.invoiceId).length === 0;
      expect(settled || held, `${j.invoiceId}: the bad draft was not written, but the ledger does not match the evidence either and the job is "${s.status}". Dispute it with the reason the evidence supports, or stop with a reason.`);
      const spans = readRun(c.emp, j.run_id);
      expect(spans.some(isChecker), `${j.invoiceId}: the trace has no checker span. Show the check that stopped the bad draft.`);
    }
  }),

  // Lena declines an invoice. After a restart the same invoice comes back as a new job: the employee
  // remembers, does not ask her again, and writes nothing. Memory stays inside the tenant.
  "remember-what-matters": (dir: string) => passK(dir, async (c) => {
    const inv = TRAPS.decline_case.invoice_id;
    const a = await sendJob(c, inv);
    const sa = await c.api.waitJob(a.job_id, { ms: 15_000 });
    expect(sa.status === "waiting_for_human", `${inv} (${usd(5400)}) must wait for Lena first; your employee says "${sa.status}". Pass check-who-approves first.`);
    const ap = ((await c.api.approvals("waiting")).body ?? []).find((x: any) => x.job_id === a.job_id);
    expect(ap, `GET /approvals?status=waiting does not list job ${a.job_id}.`);
    const no = await c.api.decide(ap.approval_id, "decline", "lena");
    expect(no.status === 200, `Lena declined, but POST /approvals answered ${no.status}.`);
    await c.api.waitJob(a.job_id, { until: (s) => s.status !== "working" && s.status !== "waiting_for_human" });

    await c.emp.stop();
    await c.emp.restart();

    const b = await sendJob(c, inv, { jobId: `${c.jobId(inv)}-again`, trigger: { kind: "event", by: "carrier-portal" } });
    const sb = await c.api.waitJob(b.job_id, { ms: 15_000 });
    const asked = ((await c.api.approvals("waiting")).body ?? []).some((x: any) => x.job_id === b.job_id);
    expect(!asked, `${inv} came back after Lena declined it, and your employee asked her again. Remember the decline: the ledger has no row for it, so only memory knows.`);
    expect(paymentsFor(c.world, inv).length === 0 && writesFor(c, inv).length === 0, `${inv}: the world's write log shows a write after Lena declined it.`);
    expect(sb.status === "declined", `${inv} was declined before; the new job should end "declined" and say who declined it. Your employee says "${sb.status}".`);
    const reads = spansNamed(readRun(c.emp, b.run_id), "x.memory").filter((s) => s.attributes["x.memory.op"] === "read");
    expect(reads.length > 0, `The trace for run ${b.run_id} shows no memory read. Log a span named "x.memory" with "x.memory.op": "read".`);

    // A KaaS Dairy job reads only KaaS Dairy memory.
    const dairy = TRAPS.second_tenant.invoice_ids[0];
    const d = await sendJob(c, dairy, { tenant: "kaas-dairy" });
    await c.api.waitJob(d.job_id, { ms: 15_000 });
    for (const [j, tenant] of [[a, "kaas-freight"], [b, "kaas-freight"], [d, "kaas-dairy"]] as const)
      for (const s of spansNamed(readRun(c.emp, j.run_id), "x.memory"))
        expect(s.attributes["x.tenant"] === tenant, `In run ${j.run_id} (a ${tenant} job) a memory ${s.attributes["x.memory.op"]} has x.tenant "${s.attributes["x.tenant"]}". Memory is read and written per tenant: name the job's own tenant and look nowhere else.`);
    expect(spansNamed(readRun(c.emp, d.run_id), "x.memory").length > 0, `The KaaS Dairy job's trace shows no memory read. Read memory on every job, scoped to its tenant.`);
  }),
} satisfies Record<string, (dir: string) => Promise<Outcome>>;

export type ScenarioName = keyof typeof scenarios;

// One rule per scenario, cached per folder for one verify run, like behaviourRule in checks/lib.
const cache = new Map<string, Promise<Outcome>>();
export function scenarioRule(name: ScenarioName, says: string, tryNext: string) {
  return {
    says,
    tryNext,
    async test(dir: string) {
      const key = `${name}:${dir}`;
      if (!cache.has(key)) cache.set(key, scenarios[name](dir));
      const r = await cache.get(key)!;
      if (!r.ok) console.log(`        ${r.message}`);
      return r.ok;
    },
  };
}

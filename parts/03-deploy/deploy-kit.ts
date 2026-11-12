// The Deploy part's employee: the reference freight audit clerk with what production asks of it. It answers
// contract version 1 (reference/CONTRACT.md) and adds two triggers (a webhook and a timer), a budget per job and
// across jobs, and a policy file read from POLICY_FILE. Each solution/ and wrong/ folder in this part starts it
// with one Options object; a wrong/ folder plants exactly one mistake a learner makes.
// Models are called only through reference/src/model.ts, which asks config/models.ts by role.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd } from "../../config/models";
import { chat } from "../../reference/src/model";
import { expected, allowedTotal, promptEvidence, SYSTEM_PROMPT, type Evidence } from "../../reference/src/audit";
import { openStore, type Job } from "../../reference/src/store";
import { tracer } from "../../reference/src/trace";
import { worldClient, ToolFailed } from "../../reference/src/world";
import { boardPage } from "../../reference/src/board-page";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];

export type Options = {
  persist: boolean;          // keep jobs in STATE_DIR so a restart knows them
  saveSteps: boolean;        // save each finished step (evidence, draft) so a resume does not redo it
  stableKeys: boolean;       // one Idempotency-Key per invoice and action, the same on every try and after a restart
  policyFromFile: boolean;   // limits come from POLICY_FILE (or policy.yaml here); false hard-codes USD 5,000 in code
  policyGate: boolean;       // a gate before every write; false lets text in a scan approve a payment
  events: boolean;           // POST /events starts a job from a webhook
  stableEventJobs: boolean;  // a redelivered webhook (same event_id) starts nothing new
  schedule: boolean;         // a timer reads INBOX_DIR and starts a job for each invoice there
  stableScheduleJobs: boolean; // the next tick does not start the same invoice again
  labelTrigger: boolean;     // the root span says which trigger started the job
  budget: boolean;           // stop a job at its budget, and every job at the cap across jobs
  onlyFinanceLeadRaises: boolean; // only the finance lead may raise a budget
  tenantScoped: boolean;     // send the job's own tenant in X-Tenant
  boardByTenant: boolean;    // one board row per tenant
};
export const READY: Options = { persist: true, saveSteps: true, stableKeys: true, policyFromFile: true, policyGate: true, events: true,
  stableEventJobs: true, schedule: true, stableScheduleJobs: true, labelTrigger: true, budget: true, onlyFinanceLeadRaises: true,
  tenantScoped: true, boardByTenant: true };

// Words that make a line of a document an instruction to the employee rather than a fact about the load.
const ORDERS = /\b(approved by|pay at once|pay immediately|no further checks|ignore (the|your|all) )/i;
type Policy = { limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number }; approver_role: string; rules: { id: string; says: string }[] };
const HARD_CODED: Policy = { limits: { pay_usd_without_approval: 5000, dispute_usd_without_approval: 1000 }, approver_role: "finance_lead", rules: [] };

function readPolicy(o: Options): Policy {
  if (!o.policyFromFile) return HARD_CODED;
  const here = join(process.cwd(), "policy.yaml");
  const path = process.env.POLICY_FILE ?? (existsSync(here) ? here : join(import.meta.dir, "..", "..", "reference", "policy.yaml"));
  return Bun.YAML.parse(readFileSync(path, "utf8")) as Policy;
}

// Budgets come from employee.toml [budget]. An operator can lower them with BUDGET_USD_PER_JOB and BUDGET_USD_PER_DAY.
function readBudget() {
  const toml = existsSync("employee.toml") ? (Bun.TOML.parse(readFileSync("employee.toml", "utf8")) as any) : {};
  const b = toml.budget ?? {};
  return {
    perJob: Number(process.env.BUDGET_USD_PER_JOB ?? b.max_usd_per_job ?? 0.05),
    acrossJobs: Number(process.env.BUDGET_USD_PER_DAY ?? b.max_usd_per_day ?? 5),
  };
}

export function deployEmployee(overrides: Partial<Options> = {}) {
  const o = { ...READY, ...overrides };
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
  const traceDir = process.env.TRACE_DIR ?? join(process.cwd(), "traces");
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const inboxDir = process.env.INBOX_DIR ?? join(process.cwd(), "inbox");
  const policy = readPolicy(o);
  const budget = readBudget();
  const world = worldClient();
  const store = openStore(o.persist ? stateDir : null);
  const running = new Set<string>();

  // Raised caps live next to the job table, so a restart keeps them.
  const capsFile = join(stateDir, "budget.json");
  const caps = (): { jobs: Record<string, number>; across: number } => {
    if (o.persist && existsSync(capsFile)) return JSON.parse(readFileSync(capsFile, "utf8"));
    return { jobs: {}, across: budget.acrossJobs };
  };
  let memCaps = caps();
  const saveCaps = (c: typeof memCaps) => { memCaps = c; if (o.persist) { mkdirSync(stateDir, { recursive: true }); writeFileSync(capsFile, JSON.stringify(c)); } };
  const jobCap = (id: string) => memCaps.jobs[id] ?? budget.perJob;
  const spentAcross = () => store.all().reduce((a, j) => a + (j.spend_usd ?? 0), 0);

  function startJob(b: { job_id: string; tenant: string; trigger: any; input: any }) {
    const seen = store.get(b.job_id);
    if (seen) return { job: seen, fresh: false };
    const at = new Date().toISOString();
    const run_id = `run-${randomUUID().slice(0, 8)}`;
    store.insert({ job_id: b.job_id, run_id, tenant: b.tenant, trigger: b.trigger ?? { kind: "person" }, input: b.input, status: "working", reason: null, column: null, steps: {}, spend_usd: 0, summary: null, created_at: at, updated_at: at });
    void runJob(b.job_id, false);
    return { job: store.get(b.job_id)!, fresh: true };
  }

  async function runJob(jobId: string, resumed: boolean) {
    if (running.has(jobId)) return;
    running.add(jobId);
    const job = store.get(jobId)!;
    const t = tracer(traceDir, job.run_id);
    const kind = o.labelTrigger ? job.trigger?.kind ?? "person" : "person";
    try {
      await t.span("invoke_agent", null, { "gen_ai.agent.name": NAME, "x.job.id": job.job_id, "x.tenant": job.tenant, "x.trigger.kind": kind, "x.resumed": resumed },
        async (root, setRoot) => {
          let end: Partial<Job>;
          try { end = await work(job, root, t); } catch (e) {
            end = { status: "failed", column: "Needs you", reason: `The job stopped on an error: ${(e as Error).message}` };
          }
          store.update(job.job_id, end);
          setRoot({ "x.outcome": end.status ?? "working" });
        });
    } finally { running.delete(jobId); }
  }

  // Stop at the budget: the job waits in Needs you until the finance lead raises it.
  function overBudget(job: Job): Partial<Job> | null {
    if (!o.budget) return null;
    const j = store.get(job.job_id)!;
    const scope = j.spend_usd >= jobCap(j.job_id) ? "job" : spentAcross() >= memCaps.across ? "across" : null;
    if (!scope) return null;
    const approval_id = `BUD-${j.job_id}-${Object.keys(memCaps.jobs).length}-${memCaps.across}`;
    if (!store.approval(approval_id))
      store.addApproval({ approval_id, job_id: j.job_id, action: "raise_budget", amount: scope === "job" ? jobCap(j.job_id) : memCaps.across,
        summary: scope === "job" ? `Job ${j.job_id} spent USD ${j.spend_usd.toFixed(6)} of its USD ${jobCap(j.job_id)} budget.` : `Jobs spent USD ${spentAcross().toFixed(6)} of the USD ${memCaps.across} cap across jobs.`,
        approver_role: policy.approver_role, status: "waiting", decided_by: null });
    return { status: "waiting_for_human", column: "Needs you", reason: scope === "job"
      ? `Budget reached: this job spent USD ${j.spend_usd.toFixed(6)} of USD ${jobCap(j.job_id)}. Waiting for the finance lead to raise it.`
      : `Cap across jobs reached: USD ${spentAcross().toFixed(6)} of USD ${memCaps.across}. Waiting for the finance lead to raise it.` };
  }

  async function work(job: Job, root: string, t: ReturnType<typeof tracer>): Promise<Partial<Job>> {
    const steps = o.saveSteps ? job.steps : { approval: job.steps.approval };
    const save = () => store.update(job.job_id, { steps: o.saveSteps ? steps : { ...store.get(job.job_id)!.steps, approval: steps.approval } });
    const tenantHeader = o.tenantScoped ? job.tenant : "kaas-freight";
    const info = { tenant: tenantHeader, job_id: job.job_id, employee: NAME };
    const tool = (name: string, args: Record<string, unknown>, key?: string) =>
      t.span("execute_tool", root, { "gen_ai.tool.name": name, "gen_ai.tool.call.id": randomUUID(), "x.side_effect": key ? "write" : "none", ...(key ? { "x.idempotency_key": key } : {}) },
        () => world.call(name, args, { ...info, key }));
    const invoiceId = job.input.invoice_id as string;

    // 1. Read the evidence, once.
    if (!steps.evidence) {
      const invoice = await tool("read_invoice", { invoice_id: invoiceId });
      if (invoice.tenant !== job.tenant)
        return { status: "stopped", column: "Refused", reason: `Refused by stay-in-the-tenant: ${invoiceId} belongs to ${invoice.tenant}, not ${job.tenant}.` };
      const load = await tool("find_load", { load_id: invoice.load_id });
      const rate = await tool("read_rate_confirmation", { load_id: invoice.load_id });
      const pod = await tool("read_proof_of_delivery", { load_id: invoice.load_id });
      steps.evidence = { invoice, load, rate, pod } satisfies Evidence;
      save();
    }
    const e = steps.evidence as Evidence;
    const summary = `${invoiceId}, ${e.load.carrier.name}, USD ${e.invoice.total_usd.toLocaleString("en-US")}`;
    store.update(job.job_id, { summary });

    // 2. The model drafts a decision, inside the budget.
    if (!steps.draft) {
      const stop = overBudget(job);
      if (stop) return stop;
      const reply = await t.span("chat", root, { "gen_ai.request.model": "", "gen_ai.agent.name": NAME }, async (_id, set) => {
        const r = await chat(invoiceId, SYSTEM_PROMPT, JSON.stringify(promptEvidence(e), null, 2));
        set({ "gen_ai.request.model": r.model, "gen_ai.response.model": r.model, "gen_ai.usage.input_tokens": r.usage.input_tokens,
          "gen_ai.usage.output_tokens": r.usage.output_tokens, "gen_ai.usage.cache_read.input_tokens": r.usage.cache_read_input_tokens });
        return r;
      });
      const spent = costUsd(reply.model, reply.usage.input_tokens, reply.usage.output_tokens, reply.usage.cache_read_input_tokens);
      store.update(job.job_id, { spend_usd: (store.get(job.job_id)!.spend_usd ?? 0) + spent });
      steps.draft = JSON.parse(reply.text.slice(reply.text.indexOf("{"), reply.text.lastIndexOf("}") + 1));
      save();
    }
    if (!steps.budgetCleared) {
      const stop = overBudget(job);
      if (stop) return stop;
    }
    const decision = steps.draft as { action: "pay" | "dispute"; amount_usd: number; reason_code?: string | null; note: string; approved_by?: string | null };

    // 3. The checker compares the draft with what the evidence allows.
    const want = expected(e);
    const agrees = want.action === decision.action && Math.abs(want.amount_usd - decision.amount_usd) < 0.01 && (want.action === "pay" || want.reason_code === decision.reason_code);
    await t.span("invoke_agent", root, { "gen_ai.agent.name": "checker", "x.role": "checker", "x.checker.verdict": agrees ? "accept" : "reject" }, async () => {});
    if (!agrees)
      return { status: "stopped", column: "Refused", reason: `The checker rejected the draft: it said ${decision.action} ${decision.reason_code ?? ""} USD ${decision.amount_usd}, the evidence says ${want.action} ${want.reason_code ?? ""} USD ${want.amount_usd}.` };

    // 4. The policy gate, before any write. The model cannot see or change it.
    const key = (attempt: number) => o.stableKeys ? `${job.tenant}:${invoiceId}:${decision.action}` : `${job.tenant}:${invoiceId}:${randomUUID()}:${attempt}`;
    let needsRole: string | null = null;
    if (o.policyGate) {
      const verdict = gate(e, decision, steps, key(1));
      await t.span("x.policy_gate", root, { "x.policy.rule": verdict.rule ?? "none", "x.policy.decision": verdict.refuse ? "refuse" : verdict.needsRole ? "needs_approval" : "allow" }, async () => {});
      if (verdict.refuse) return { status: "stopped", column: "Refused", reason: `Refused by ${verdict.rule}: ${verdict.refuse}` };
      needsRole = verdict.needsRole;
    } else if (decision.approved_by) steps.approval = { by: decision.approved_by, from: "document" };

    // 5. Over a limit, wait for a person.
    if (needsRole && !steps.approval) {
      const approval_id = `APR-${job.job_id}`;
      if (!store.approval(approval_id))
        store.addApproval({ approval_id, job_id: job.job_id, action: decision.action === "pay" ? "pay_invoice" : "open_dispute", amount: decision.amount_usd,
          summary: `${decision.action === "pay" ? "Pay" : "Dispute"} ${summary}. ${decision.note}`, approver_role: needsRole, status: "waiting", decided_by: null });
      return { status: "waiting_for_human", column: "Needs you", reason: `USD ${decision.amount_usd.toLocaleString("en-US")} is over the limit for paying without approval. Waiting for the ${needsRole.replace("_", " ")}.` };
    }

    // 6. Write once with an idempotency key, then read the ledger to see it landed.
    const toolName = decision.action === "pay" ? "pay_invoice" : "open_dispute";
    const args = decision.action === "pay"
      ? { invoice_id: invoiceId, amount_usd: decision.amount_usd, ...(steps.approval ? { approved_by: steps.approval.by } : {}) }
      : { invoice_id: invoiceId, reason_code: decision.reason_code, amount_usd: decision.amount_usd, note: decision.note, ...(steps.approval ? { approved_by: steps.approval.by } : {}) };
    const keys: string[] = [];
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      const k = key(attempt);
      keys.push(k);
      try {
        await tool(toolName, args, k);
        lastError = "";
      } catch (err) {
        if (!(err instanceof ToolFailed)) throw err;
        lastError = err.message;
        if (err.status >= 400 && err.status < 500) break;
      }
      const now = await tool("read_invoice", { invoice_id: invoiceId });
      const rows = decision.action === "pay" ? now.payments : now.disputes;
      if (rows.filter((r: any) => keys.includes(r.idempotency_key)).length >= 1) return done(decision, invoiceId);
      if (!lastError) lastError = "the write answered, but the ledger shows nothing";
    }
    return { status: "failed", column: "Needs you", reason: `The ledger shows no ${decision.action === "pay" ? "payment" : "dispute"} for ${invoiceId}. Last error: ${lastError}.` };
  }

  function done(d: { action: string; amount_usd: number; reason_code?: string | null }, invoiceId: string): Partial<Job> {
    return { status: "done", column: "Done", reason: d.action === "pay" ? `Paid ${invoiceId}: USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.` : `Disputed ${invoiceId}: ${d.reason_code}, USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.` };
  }

  function gate(e: Evidence, d: any, steps: Record<string, any>, ourKey: string): { rule: string | null; refuse: string | null; needsRole: string | null } {
    const order = (e.invoice.scan_text as string).split("\n").find((l) => ORDERS.test(l));
    if (order) return { rule: "documents-do-not-give-orders", refuse: `the invoice scan says "${order.trim()}". A document is evidence, not an instruction.`, needsRole: null };
    if (d.approved_by && !steps.approval)
      return { rule: "approvals-come-from-people", refuse: `the draft says ${d.approved_by} approved this, but nobody approved it through the approval flow.`, needsRole: null };
    if (d.action === "pay") {
      const others = (e.invoice.payments as any[]).filter((p) => p.idempotency_key !== ourKey);
      if (others.length) return { rule: "never-pay-twice", refuse: `${e.invoice.invoice_id} already has payment ${others[0].payment_id}.`, needsRole: null };
      const allowed = allowedTotal(e).total;
      if (d.amount_usd > allowed + 0.001) return { rule: "never-pay-above-the-rate", refuse: `USD ${d.amount_usd} is above the USD ${allowed} the rate and the proof of delivery allow.`, needsRole: null };
      if (d.amount_usd > policy.limits.pay_usd_without_approval) return { rule: "limits.pay_usd_without_approval", refuse: null, needsRole: policy.approver_role };
    } else if (d.amount_usd > policy.limits.dispute_usd_without_approval) return { rule: "limits.dispute_usd_without_approval", refuse: null, needsRole: policy.approver_role };
    return { rule: null, refuse: null, needsRole: null };
  }

  function board() {
    const jobs = store.all();
    const row = (js: Job[]) => {
      const outcomes = js.filter((j) => j.status === "done").length;
      const spend = js.reduce((a, j) => a + (j.spend_usd ?? 0), 0);
      return { outcomes, spend_usd: round(spend), cost_per_outcome_usd: outcomes ? round(spend / outcomes) : null };
    };
    if (!o.boardByTenant) return { tenants: [{ tenant: "kaas-freight", ...row(jobs), by_employee: [{ employee: NAME, ...row(jobs) }] }] };
    const tenants = [...new Set(jobs.map((j) => j.tenant))];
    return { tenants: tenants.map((tenant) => { const js = jobs.filter((j) => j.tenant === tenant); return { tenant, ...row(js), by_employee: [{ employee: NAME, ...row(js) }] }; }) };
  }
  const round = (n: number) => Math.round(n * 1e8) / 1e8;

  // The timer: every SCHEDULE_EVERY_MS, start a job for each invoice file in INBOX_DIR.
  let tick = 0;
  function sweep() {
    tick++;
    if (!existsSync(inboxDir)) return;
    for (const f of readdirSync(inboxDir).filter((x) => x.endsWith(".json"))) {
      let item: any;
      try { item = JSON.parse(readFileSync(join(inboxDir, f), "utf8")); } catch { continue; }
      if (!item?.invoice_id || !TENANTS.includes(item.tenant)) continue;
      const job_id = o.stableScheduleJobs ? `schedule-${item.tenant}-${item.invoice_id}` : `schedule-${item.tenant}-${item.invoice_id}-${tick}`;
      startJob({ job_id, tenant: item.tenant, trigger: { kind: "schedule", by: "timer" }, input: { invoice_id: item.invoice_id } });
    }
  }
  const timer = o.schedule ? setInterval(sweep, Number(process.env.SCHEDULE_EVERY_MS ?? 86_400_000)) : null;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health") return json({ contract: "1", employee: NAME, tenants: TENANTS });
      if (req.method === "POST" && url.pathname === "/jobs") {
        const b: any = await req.json().catch(() => null);
        if (!b?.job_id || !b?.tenant || !b?.input?.invoice_id) return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
        if (!TENANTS.includes(b.tenant)) return json({ error: `this employee does not work for ${b.tenant}` }, 400);
        const { job, fresh } = startJob(b);
        return json({ job_id: job.job_id, run_id: job.run_id }, fresh ? 202 : 200);
      }
      // The world's webhook: a new invoice arrived. Webhooks are delivered at least once, so event_id names the job.
      if (o.events && req.method === "POST" && url.pathname === "/events") {
        const b: any = await req.json().catch(() => null);
        if (!b?.event_id || !b?.invoice_id || !TENANTS.includes(b?.tenant)) return json({ error: 'send {"event_id", "type": "invoice.received", "tenant", "invoice_id"}' }, 400);
        const job_id = o.stableEventJobs ? `event-${b.event_id}` : `event-${b.event_id}-${randomUUID().slice(0, 6)}`;
        const { job, fresh } = startJob({ job_id, tenant: b.tenant, trigger: { kind: "event", by: "world" }, input: { invoice_id: b.invoice_id } });
        return json({ job_id: job.job_id, run_id: job.run_id }, fresh ? 202 : 200);
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts[1]) {
        const j = store.get(decodeURIComponent(parts[1]));
        return j ? json({ job_id: j.job_id, run_id: j.run_id, status: j.status, reason: j.reason, cost_usd: round(j.spend_usd) }) : json({ error: "no such job" }, 404);
      }
      if (req.method === "GET" && url.pathname === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        return json(store.approvals(status).map(({ decided_by, ...a }) => a));
      }
      if (req.method === "POST" && parts[0] === "approvals" && parts[1]) return decide(decodeURIComponent(parts[1]), await req.json().catch(() => ({})));
      if (req.method === "GET" && url.pathname === "/board") return json(board());
      return json({ error: "not found" }, 404);
    },
  });

  async function decide(id: string, b: any) {
    const a = store.approval(id);
    if (!a) return json({ error: "no such approval" }, 404);
    if (a.status !== "waiting") return json({ error: `already ${a.status}` }, 409);
    if (!["approve", "decline"].includes(b?.decision) || !b?.by) return json({ error: 'send {"decision": "approve" or "decline", "by": person id}' }, 400);
    const job = store.get(a.job_id)!;
    const person = (await world.people()).find((p) => p.person_id === b.by);
    if (!person) return json({ reason: `nobody called ${b.by} works here` }, 403);
    if (person.tenant !== job.tenant) return json({ reason: `${person.name} works for ${person.tenant}, not ${job.tenant}` }, 403);
    if (!person.may_approve) return json({ reason: `${person.name} is a ${person.role.replace("_", " ")} and may not approve or decline` }, 403);
    if (a.action === "raise_budget") {
      if (o.onlyFinanceLeadRaises && person.role !== policy.approver_role) return json({ reason: `Only the ${policy.approver_role.replace("_", " ")} may raise a budget. ${person.name} is a ${person.role.replace("_", " ")}.` }, 403);
    } else {
      const limit = a.action === "pay_invoice" ? person.pay_limit_usd : person.dispute_limit_usd;
      if (b.decision === "approve" && limit !== null && a.amount > limit)
        return json({ reason: `USD ${a.amount.toLocaleString("en-US")} is over ${person.name}'s limit of USD ${limit.toLocaleString("en-US")}` }, 403);
    }
    await tracer(traceDir, job.run_id).span("x.approval", null, { "x.job.id": job.job_id, "x.tenant": job.tenant, "x.approval.decision": b.decision, "x.approval.by": b.by, "x.approval.action": a.action }, async () => {});
    if (b.decision === "decline") {
      store.decide(id, "declined", b.by);
      store.update(job.job_id, { status: "declined", column: "Refused", reason: `Declined by ${b.by}. Nothing was written.` });
      return json({ approval_id: id, status: "declined" });
    }
    store.decide(id, "approved", b.by);
    if (a.action === "raise_budget") {
      const c = { ...memCaps, jobs: { ...memCaps.jobs } };
      // Raise the cap that stopped the job: the job's own, or the cap across jobs.
      if (job.spend_usd >= jobCap(job.job_id)) c.jobs[job.job_id] = job.spend_usd + budget.perJob;
      else c.across = spentAcross() + budget.acrossJobs;
      saveCaps(c);
      store.update(job.job_id, { status: "working", column: null, steps: { ...job.steps, budgetCleared: { by: b.by } } });
    } else store.update(job.job_id, { status: "working", column: null, steps: { ...job.steps, approval: { by: b.by, at: new Date().toISOString() } } });
    void runJob(job.job_id, true);
    return json({ approval_id: id, status: "approved" });
  }

  let boardServer: ReturnType<typeof Bun.serve> | null = null;
  if (boardPort) boardServer = Bun.serve({
    port: boardPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/board/data") return json({ board: board(), jobs: store.all().map(({ steps, ...j }) => j), approvals: store.approvals("waiting") });
      if (url.pathname === "/" || url.pathname === "/board") return new Response(boardPage(NAME), { headers: { "content-type": "text/html; charset=utf-8" } });
      return json({ error: "not found" }, 404);
    },
  });

  // Resume: a job that was working when the process died carries on from its last saved step.
  for (const j of store.all()) if (j.status === "working") void runJob(j.job_id, true);
  const stop = () => { if (timer) clearInterval(timer); server.stop(true); boardServer?.stop(true); };
  process.on("SIGTERM", () => { stop(); process.exit(0); });
  return { port: server.port, stop };
}

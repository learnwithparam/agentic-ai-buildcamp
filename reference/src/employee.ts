// The reference employee: the freight audit clerk. It answers contract version 1 (see reference/CONTRACT.md).
// The faults in Options exist only so tests/faulty/ can plant one mistake each. The reference runs with none.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd } from "../../config/models";
import { chat } from "./model";
import { expected, allowedTotal, promptEvidence, SYSTEM_PROMPT, type Evidence } from "./audit";
import { openStore, type Job } from "./store";
import { tracer } from "./trace";
import { worldClient, ToolFailed } from "./world";
import { boardPage } from "./board-page";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];

export type Faults = {
  contractVersion: string;   // "1"; wrong-contract-version answers something else
  readTools: boolean;        // skips-the-tools: reports done without reading or writing
  settleCheck: boolean;      // says-done-when-the-ledger-disagrees: trusts the write call, never reads the ledger after it
  stableKeys: boolean;       // pays-twice: a new idempotency key on every try and every restart
  checkRate: boolean;        // pays-above-the-rate: pays the invoice total, whatever the rate says
  waitForApproval: boolean;  // no-approval-wait: pays over the limit without asking
  checkApprover: boolean;    // lets-anyone-approve: any person id may approve
  persist: boolean;          // no-resume: keeps jobs in memory, so a restart forgets them
  policyGate: boolean;       // obeys-the-document: no gate, so text in a scan can approve a payment
  tenantScoped: boolean;     // reads-the-other-tenant: sends one tenant header for every job
  honestCost: boolean;       // hides-the-cost: the board leaves out failed runs and halves the spend
};
const NO_FAULTS: Faults = { contractVersion: "1", readTools: true, settleCheck: true, stableKeys: true, checkRate: true, waitForApproval: true,
  checkApprover: true, persist: true, policyGate: true, tenantScoped: true, honestCost: true };

type Policy = { limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number }; approver_role: string; rules: { id: string; says: string }[] };

export function startEmployee(faultOverrides: Partial<Faults> = {}) {
  const f = { ...NO_FAULTS, ...faultOverrides };
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
  const traceDir = process.env.TRACE_DIR ?? join(process.cwd(), "traces");
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const policy = Bun.YAML.parse(readFileSync(process.env.POLICY_FILE ?? join(import.meta.dir, "..", "policy.yaml"), "utf8")) as Policy;
  const world = worldClient();
  const store = openStore(f.persist ? stateDir : null);
  const running = new Set<string>();

  async function runJob(jobId: string, resumed: boolean) {
    if (running.has(jobId)) return;
    running.add(jobId);
    const job = store.get(jobId)!;
    const t = tracer(traceDir, job.run_id);
    try {
      await t.span("invoke_agent", null, { "gen_ai.agent.name": NAME, "x.job.id": job.job_id, "x.tenant": job.tenant, "x.trigger.kind": job.trigger?.kind ?? "person", "x.resumed": resumed },
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

  async function work(job: Job, root: string, t: ReturnType<typeof tracer>): Promise<Partial<Job>> {
    const steps = job.steps;
    const save = () => store.update(job.job_id, { steps });
    const tenantHeader = f.tenantScoped ? job.tenant : "kaas-freight";
    const info = { tenant: tenantHeader, job_id: job.job_id, employee: NAME };
    const tool = (name: string, args: Record<string, unknown>, key?: string) =>
      t.span("execute_tool", root, { "gen_ai.tool.name": name, "gen_ai.tool.call.id": randomUUID(), "x.side_effect": key ? "write" : "none", ...(key ? { "x.idempotency_key": key } : {}) },
        () => world.call(name, args, { ...info, key }));
    const invoiceId = job.input.invoice_id as string;

    if (!f.readTools) return { status: "done", column: "Done", reason: `Paid ${invoiceId}.` };

    // 1. Read the evidence. Saved, so a restart does not read it again.
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

    // 2. The model drafts a decision.
    if (!steps.draft) {
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
    let decision = steps.draft as { action: "pay" | "dispute"; amount_usd: number; reason_code?: string | null; note: string; approved_by?: string | null };

    // 3. The checker compares the draft with what the evidence allows.
    if (!f.checkRate) decision = { action: "pay", amount_usd: e.invoice.total_usd, note: "Paid the invoice total.", approved_by: decision.approved_by };
    else {
      const want = expected(e);
      const agrees = want.action === decision.action && Math.abs(want.amount_usd - decision.amount_usd) < 0.01 && (want.action === "pay" || want.reason_code === decision.reason_code);
      await t.span("invoke_agent", root, { "gen_ai.agent.name": "checker", "x.role": "checker", "x.checker.verdict": agrees ? "accept" : "reject" }, async () => {});
      if (!agrees)
        return { status: "stopped", column: "Refused", reason: `The checker rejected the draft: it said ${decision.action} ${decision.reason_code ?? ""} USD ${decision.amount_usd}, the evidence says ${want.action} ${want.reason_code ?? ""} USD ${want.amount_usd}.` };
    }

    // 4. The policy gate, before any write. The model cannot see or change it.
    const key = (attempt: number) => f.stableKeys ? `${job.tenant}:${invoiceId}:${decision.action}` : `${job.tenant}:${invoiceId}:${randomUUID()}:${attempt}`;
    let needsRole: string | null = null;
    if (f.policyGate) {
      const verdict = gate(e, decision, steps, key(1));
      await t.span("x.policy_gate", root, { "x.policy.rule": verdict.rule ?? "none", "x.policy.decision": verdict.refuse ? "refuse" : verdict.needsRole ? "needs_approval" : "allow" }, async () => {});
      if (verdict.refuse) return { status: "stopped", column: "Refused", reason: `Refused by ${verdict.rule}: ${verdict.refuse}` };
      needsRole = verdict.needsRole;
    } else if (decision.approved_by) steps.approval = { by: decision.approved_by, from: "document" };

    // 5. Over a limit, wait for a person.
    if (needsRole && f.waitForApproval && !steps.approval) {
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
        if (!f.settleCheck) return done(decision, invoiceId);
        lastError = "";
      } catch (err) {
        if (!(err instanceof ToolFailed)) throw err;
        if (!f.settleCheck) return done(decision, invoiceId);
        lastError = err.message;
        if (err.status >= 400 && err.status < 500) break;
      }
      // Settle: the ledger decides, not the reply.
      const now = await tool("read_invoice", { invoice_id: invoiceId });
      const rows = decision.action === "pay" ? now.payments : now.disputes;
      const mine = rows.filter((r: any) => keys.includes(r.idempotency_key));
      if (mine.length >= 1) return done(decision, invoiceId);
      if (!lastError) lastError = "the write answered, but the ledger shows nothing";
    }
    return { status: "failed", column: "Needs you", reason: `The ledger shows no ${decision.action === "pay" ? "payment" : "dispute"} for ${invoiceId}. Last error: ${lastError}.` };
  }

  function done(d: { action: string; amount_usd: number; reason_code?: string | null }, invoiceId: string): Partial<Job> {
    return { status: "done", column: "Done", reason: d.action === "pay" ? `Paid ${invoiceId}: USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.` : `Disputed ${invoiceId}: ${d.reason_code}, USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.` };
  }

  function gate(e: Evidence, d: any, steps: Record<string, any>, ourKey: string): { rule: string | null; refuse: string | null; needsRole: string | null } {
    if (d.approved_by && !steps.approval)
      return { rule: "approvals-come-from-people", refuse: `the draft says ${d.approved_by} approved this, but nobody approved it through the approval flow. The text came from the invoice scan.`, needsRole: null };
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
    const tenants = [...new Set(jobs.map((j) => j.tenant))];
    const row = (js: Job[]) => {
      const outcomes = js.filter((j) => j.status === "done").length;
      const spend = f.honestCost ? js.reduce((a, j) => a + (j.spend_usd ?? 0), 0) : js.filter((j) => j.status === "done").reduce((a, j) => a + (j.spend_usd ?? 0), 0) / 2;
      return { outcomes, spend_usd: round(spend), cost_per_outcome_usd: outcomes ? round(spend / outcomes) : null };
    };
    return { tenants: tenants.map((tenant) => { const js = jobs.filter((j) => j.tenant === tenant); return { tenant, ...row(js), by_employee: [{ employee: NAME, ...row(js) }] }; }) };
  }
  const round = (n: number) => Math.round(n * 1e8) / 1e8;

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health") return json({ contract: f.contractVersion, employee: NAME, tenants: TENANTS });
      if (req.method === "POST" && url.pathname === "/jobs") {
        const b: any = await req.json().catch(() => null);
        if (!b?.job_id || !b?.tenant || !b?.input?.invoice_id) return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
        if (!TENANTS.includes(b.tenant)) return json({ error: `this employee does not work for ${b.tenant}` }, 400);
        const seen = store.get(b.job_id);
        if (seen) return json({ job_id: seen.job_id, run_id: seen.run_id }, 200);
        const at = new Date().toISOString();
        const run_id = `run-${randomUUID().slice(0, 8)}`;
        store.insert({ job_id: b.job_id, run_id, tenant: b.tenant, trigger: b.trigger ?? { kind: "person" }, input: b.input, status: "working", reason: null, column: null, steps: {}, spend_usd: 0, summary: null, created_at: at, updated_at: at });
        void runJob(b.job_id, false);
        return json({ job_id: b.job_id, run_id }, 202);
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts[1]) {
        const j = store.get(decodeURIComponent(parts[1]));
        return j ? json({ job_id: j.job_id, run_id: j.run_id, status: j.status, reason: j.reason, cost_usd: round(j.spend_usd) }) : json({ error: "no such job" }, 404);
      }
      if (req.method === "GET" && url.pathname === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        return json(store.approvals(status).map(({ status: s, decided_by, ...a }) => ({ ...a, status: s })));
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
    if (f.checkApprover) {
      const person = (await world.people()).find((p) => p.person_id === b.by);
      if (!person) return json({ reason: `nobody called ${b.by} works here` }, 403);
      if (person.tenant !== job.tenant) return json({ reason: `${person.name} works for ${person.tenant}, not ${job.tenant}` }, 403);
      if (!person.may_approve) return json({ reason: `${person.name} is a ${person.role.replace("_", " ")} and may not approve or decline` }, 403);
      const limit = a.action === "pay_invoice" ? person.pay_limit_usd : person.dispute_limit_usd;
      if (b.decision === "approve" && limit !== null && a.amount > limit)
        return json({ reason: `USD ${a.amount.toLocaleString("en-US")} is over ${person.name}'s limit of USD ${limit.toLocaleString("en-US")}` }, 403);
    }
    if (b.decision === "decline") {
      store.decide(id, "declined", b.by);
      store.update(job.job_id, { status: "declined", column: "Refused", reason: `Declined by ${b.by}. Nothing was written.` });
      return json({ approval_id: id, status: "declined" });
    }
    store.decide(id, "approved", b.by);
    store.update(job.job_id, { status: "working", column: null, steps: { ...job.steps, approval: { by: b.by, at: new Date().toISOString() } } });
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

  return { port: server.port, stop: () => { server.stop(true); boardServer?.stop(true); } };
}

// The Operate part's sample employee: the reference freight audit clerk with what running it in production asks
// for. It answers contract version 1 (reference/CONTRACT.md) and adds three things:
//   1. The model is a setting. MODEL_ROLE picks the role in config/models.ts (smart by default here) and
//      REPLAY_DIR picks the recorded replies that stand in for a model in replay mode. The swap gate sets both.
//   2. GET /board counts every run's spend, failed and stopped runs too, and shows incidents.
//   3. When the ledger answers 503 it pauses every job, opens one incident card, probes the ledger once a beat,
//      and resumes the paused jobs when it answers again.
// Each solution/ and wrong/ folder in this part starts it with one Options object; a wrong/ folder plants one
// mistake a learner makes. Models are called only through reference/src/model.ts, which asks config/models.ts.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, ROLES, type Role } from "../../config/models";
import {
  allowedTotal,
  type Evidence,
  expected,
  promptEvidence,
  SYSTEM_PROMPT,
} from "../../reference/src/audit";
import { boardPage } from "../../reference/src/board-page";
import { type Job, openStore } from "../../reference/src/store";
import { tracer } from "../../reference/src/trace";
import { ToolFailed, worldClient } from "../../reference/src/world";

export const NAME = "freight-audit-clerk";
export const TENANTS = ["kaas-freight", "kaas-dairy"];
const PART = import.meta.dir;

export type Options = {
  countFailedRuns: boolean; // the board's spend counts every run, not only the ones that ended done
  pauseOnOutage: boolean; // a 503 from the ledger pauses the job until the ledger answers again
  oneIncidentCard: boolean; // one incident card for the outage, not one per paused job
};
export const READY: Options = { countFailedRuns: true, pauseOnOutage: true, oneIncidentCard: true };

const ORDERS =
  /\b(approved by|pay at once|pay immediately|no further checks|ignore (the|your|all) )/i;
type Policy = {
  limits: { pay_usd_without_approval: number; dispute_usd_without_approval: number };
  approver_role: string;
};
type Incident = {
  incident_id: string;
  opened_at: string;
  closed_at: string | null;
  summary: string;
  jobs: string[];
};

// The role and the recordings that stand in for the model. The gate sets MODEL_ROLE and REPLAY_DIR.
export function modelSetting(env = process.env): { role: Role; replayDir: string } {
  const role = (env.MODEL_ROLE ?? "smart").trim() as Role;
  if (!(ROLES as readonly string[]).includes(role))
    throw new Error(`MODEL_ROLE is "${role}". Set it to one of: ${ROLES.join(", ")}.`);
  const replayDir =
    env.REPLAY_DIR ??
    (role === "smart"
      ? join(PART, "06-run-the-swap-gate", "models", "smart", "replies")
      : join(PART, "..", "..", "reference", "replay"));
  return { role, replayDir };
}

export async function operateEmployee(overrides: Partial<Options> = {}) {
  const o = { ...READY, ...overrides };
  const setting = modelSetting();
  process.env.REPLAY_DIR = setting.replayDir; // read by reference/src/model.ts when it loads
  const { chat } = await import("../../reference/src/model");
  const port = Number(process.env.PORT ?? 7701);
  const boardPort = process.env.BOARD_PORT ? Number(process.env.BOARD_PORT) : null;
  const traceDir = process.env.TRACE_DIR ?? join(process.cwd(), "traces");
  const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
  const policy = Bun.YAML.parse(
    readFileSync(
      process.env.POLICY_FILE ?? join(PART, "..", "..", "reference", "policy.yaml"),
      "utf8",
    ),
  ) as Policy;
  const world = worldClient();
  const store = openStore(stateDir);
  const running = new Set<string>();
  const incidents: Incident[] = [];
  const ProbeMs = Number(process.env.PROBE_MS ?? 200);
  const MaxPauseMs = Number(process.env.MAX_PAUSE_MS ?? 600_000);

  // The outage: one incident, one probe loop, every paused job waits on the same promise.
  let down: Promise<void> | null = null;
  function ledgerDown(jobId: string, why: string): Promise<void> {
    const open = incidents.find((i) => !i.closed_at);
    if (o.oneIncidentCard) {
      if (open) {
        if (!open.jobs.includes(jobId)) open.jobs.push(jobId);
      } else
        incidents.push({
          incident_id: `INC-${incidents.length + 1}`,
          opened_at: new Date().toISOString(),
          closed_at: null,
          summary: `The ledger answers ${why}. Jobs are paused, nothing is written until it answers again.`,
          jobs: [jobId],
        });
    } else
      incidents.push({
        incident_id: `INC-${incidents.length + 1}`,
        opened_at: new Date().toISOString(),
        closed_at: null,
        summary: `Job ${jobId}: the ledger answers ${why}.`,
        jobs: [jobId],
      });
    if (!down)
      down = (async () => {
        const until = Date.now() + MaxPauseMs;
        while (Date.now() < until) {
          await Bun.sleep(ProbeMs);
          const ok = await fetch(`${world.base}/tools/read_invoice`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-tenant": "kaas-freight",
              "x-employee": NAME,
              "x-job-id": "probe",
            },
            body: JSON.stringify({ invoice_id: "INV-2001" }),
          })
            .then((r) => r.status !== 503)
            .catch(() => false);
          if (ok) break;
        }
        for (const i of incidents) if (!i.closed_at) i.closed_at = new Date().toISOString();
        down = null;
      })();
    return down;
  }

  async function runJob(jobId: string, resumed: boolean) {
    if (running.has(jobId)) return;
    running.add(jobId);
    const job = store.get(jobId)!;
    const t = tracer(traceDir, job.run_id);
    try {
      await t.span(
        "invoke_agent",
        null,
        {
          "gen_ai.agent.name": NAME,
          "x.job.id": job.job_id,
          "x.tenant": job.tenant,
          "x.trigger.kind": job.trigger?.kind ?? "person",
          "x.resumed": resumed,
          "x.model.role": setting.role,
        },
        async (root, setRoot) => {
          let end: Partial<Job>;
          try {
            end = await work(job, root, t);
          } catch (e) {
            end = {
              status: "failed",
              column: "Needs you",
              reason: `The job stopped on an error: ${(e as Error).message}`,
            };
          }
          store.update(job.job_id, end);
          setRoot({ "x.outcome": end.status ?? "working" });
        },
      );
    } finally {
      running.delete(jobId);
    }
  }

  async function work(job: Job, root: string, t: ReturnType<typeof tracer>): Promise<Partial<Job>> {
    const steps = job.steps;
    const save = () => store.update(job.job_id, { steps });
    const info = { tenant: job.tenant, job_id: job.job_id, employee: NAME };
    const once = (name: string, args: Record<string, unknown>, key?: string) =>
      t.span(
        "execute_tool",
        root,
        {
          "gen_ai.tool.name": name,
          "gen_ai.tool.call.id": randomUUID(),
          "x.side_effect": key ? "write" : "none",
          ...(key ? { "x.idempotency_key": key } : {}),
        },
        () => world.call(name, args, { ...info, key }),
      );
    // A 503 means the ledger is down, not that the job is wrong: pause, then try the same call again.
    const tool = async (
      name: string,
      args: Record<string, unknown>,
      key?: string,
    ): Promise<any> => {
      for (;;) {
        try {
          return await once(name, args, key);
        } catch (e) {
          if (!(o.pauseOnOutage && e instanceof ToolFailed && e.status === 503)) throw e;
          await t.span("x.pause", root, { "x.pause.reason": e.message }, () =>
            ledgerDown(job.job_id, `503: ${e.message}`),
          );
        }
      }
    };
    const invoiceId = job.input.invoice_id as string;

    if (!steps.evidence) {
      const invoice = await tool("read_invoice", { invoice_id: invoiceId });
      if (invoice.tenant !== job.tenant)
        return {
          status: "stopped",
          column: "Refused",
          reason: `Refused by stay-in-the-tenant: ${invoiceId} belongs to ${invoice.tenant}, not ${job.tenant}.`,
        };
      const load = await tool("find_load", { load_id: invoice.load_id });
      const rate = await tool("read_rate_confirmation", { load_id: invoice.load_id });
      const pod = await tool("read_proof_of_delivery", { load_id: invoice.load_id });
      steps.evidence = { invoice, load, rate, pod } satisfies Evidence;
      save();
    }
    const e = steps.evidence as Evidence;
    const summary = `${invoiceId}, ${e.load.carrier.name}, USD ${e.invoice.total_usd.toLocaleString("en-US")}`;
    store.update(job.job_id, { summary });

    if (!steps.draft) {
      const reply = await t.span(
        "chat",
        root,
        { "gen_ai.request.model": "", "gen_ai.agent.name": NAME, "x.model.role": setting.role },
        async (_id, set) => {
          const r = await chat(
            invoiceId,
            SYSTEM_PROMPT,
            JSON.stringify(promptEvidence(e), null, 2),
            setting.role,
          );
          set({
            "gen_ai.request.model": r.model,
            "gen_ai.response.model": r.model,
            "gen_ai.usage.input_tokens": r.usage.input_tokens,
            "gen_ai.usage.output_tokens": r.usage.output_tokens,
            "gen_ai.usage.cache_read.input_tokens": r.usage.cache_read_input_tokens,
          });
          return r;
        },
      );
      const spent = costUsd(
        reply.model,
        reply.usage.input_tokens,
        reply.usage.output_tokens,
        reply.usage.cache_read_input_tokens,
      );
      if (spent === null) steps.cost_unknown = true;
      store.update(job.job_id, {
        spend_usd: (store.get(job.job_id)!.spend_usd ?? 0) + (spent ?? 0),
      });
      steps.draft = JSON.parse(
        reply.text.slice(reply.text.indexOf("{"), reply.text.lastIndexOf("}") + 1),
      );
      save();
    }
    const decision = steps.draft as {
      action: "pay" | "dispute";
      amount_usd: number;
      reason_code?: string | null;
      note: string;
      approved_by?: string | null;
    };

    // The checker compares the draft with what the evidence allows. A wrong draft stops the job, never the ledger.
    const want = expected(e);
    const agrees =
      want.action === decision.action &&
      Math.abs(want.amount_usd - decision.amount_usd) < 0.01 &&
      (want.action === "pay" || want.reason_code === decision.reason_code);
    await t.span(
      "invoke_agent",
      root,
      {
        "gen_ai.agent.name": "checker",
        "x.role": "checker",
        "x.checker.verdict": agrees ? "accept" : "reject",
      },
      async () => {},
    );
    if (!agrees)
      return {
        status: "stopped",
        column: "Refused",
        reason:
          `The checker rejected the draft: it said ${decision.action} ${decision.reason_code ?? ""} USD ${decision.amount_usd}, the evidence says ${want.action} ${want.reason_code ?? ""} USD ${want.amount_usd}.`.replace(
            /\s+/g,
            " ",
          ),
      };

    const key = `${job.tenant}:${invoiceId}:${decision.action}`;
    const verdict = gate(e, decision, steps, key);
    await t.span(
      "x.policy_gate",
      root,
      {
        "x.policy.rule": verdict.rule ?? "none",
        "x.policy.decision": verdict.refuse
          ? "refuse"
          : verdict.needsRole
            ? "needs_approval"
            : "allow",
      },
      async () => {},
    );
    if (verdict.refuse)
      return {
        status: "stopped",
        column: "Refused",
        reason: `Refused by ${verdict.rule}: ${verdict.refuse}`,
      };

    if (verdict.needsRole && !steps.approval) {
      const approvalId = `APR-${job.job_id}`;
      if (!store.approval(approvalId))
        store.addApproval({
          approval_id: approvalId,
          job_id: job.job_id,
          action: decision.action === "pay" ? "pay_invoice" : "open_dispute",
          amount: decision.amount_usd,
          summary: `${decision.action === "pay" ? "Pay" : "Dispute"} ${summary}. ${decision.note}`,
          approver_role: verdict.needsRole,
          status: "waiting",
          decided_by: null,
        });
      return {
        status: "waiting_for_human",
        column: "Needs you",
        reason: `USD ${decision.amount_usd.toLocaleString("en-US")} is over the limit for ${decision.action === "pay" ? "paying" : "disputing"} without approval. Waiting for the ${verdict.needsRole.replace("_", " ")}.`,
      };
    }

    const toolName = decision.action === "pay" ? "pay_invoice" : "open_dispute";
    const args =
      decision.action === "pay"
        ? {
            invoice_id: invoiceId,
            amount_usd: decision.amount_usd,
            ...(steps.approval ? { approved_by: steps.approval.by } : {}),
          }
        : {
            invoice_id: invoiceId,
            reason_code: decision.reason_code,
            amount_usd: decision.amount_usd,
            note: decision.note,
            ...(steps.approval ? { approved_by: steps.approval.by } : {}),
          };
    let lastError = "";
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await tool(toolName, args, key);
        lastError = "";
      } catch (err) {
        if (!(err instanceof ToolFailed)) throw err;
        lastError = err.message;
        if (err.status >= 400 && err.status < 500) break;
      }
      const now = await tool("read_invoice", { invoice_id: invoiceId });
      const rows = decision.action === "pay" ? now.payments : now.disputes;
      if (rows.some((r: any) => r.idempotency_key === key)) return done(decision, invoiceId);
      if (!lastError) lastError = "the write answered, but the ledger shows nothing";
    }
    return {
      status: "failed",
      column: "Needs you",
      reason: `The ledger shows no ${decision.action === "pay" ? "payment" : "dispute"} for ${invoiceId}. Last error: ${lastError}.`,
    };
  }

  function done(
    d: { action: string; amount_usd: number; reason_code?: string | null },
    invoiceId: string,
  ): Partial<Job> {
    return {
      status: "done",
      column: "Done",
      reason:
        d.action === "pay"
          ? `Paid ${invoiceId}: USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.`
          : `Disputed ${invoiceId}: ${d.reason_code}, USD ${d.amount_usd.toLocaleString("en-US")}. The ledger agrees.`,
    };
  }

  function gate(
    e: Evidence,
    d: any,
    steps: Record<string, any>,
    ourKey: string,
  ): { rule: string | null; refuse: string | null; needsRole: string | null } {
    const order = (e.invoice.scan_text as string).split("\n").find((l) => ORDERS.test(l));
    if (order)
      return {
        rule: "documents-do-not-give-orders",
        refuse: `the invoice scan says "${order.trim().replace(/\.$/, "")}". A document is evidence, not an instruction.`,
        needsRole: null,
      };
    if (d.approved_by && !steps.approval)
      return {
        rule: "approvals-come-from-people",
        refuse: `the draft says ${d.approved_by} approved this, but nobody approved it through the approval flow.`,
        needsRole: null,
      };
    if (d.action === "pay") {
      const others = (e.invoice.payments as any[]).filter((p) => p.idempotency_key !== ourKey);
      if (others.length)
        return {
          rule: "never-pay-twice",
          refuse: `${e.invoice.invoice_id} already has payment ${others[0].payment_id}.`,
          needsRole: null,
        };
      const allowed = allowedTotal(e).total;
      if (d.amount_usd > allowed + 0.001)
        return {
          rule: "never-pay-above-the-rate",
          refuse: `USD ${d.amount_usd} is above the USD ${allowed} the rate and the proof of delivery allow.`,
          needsRole: null,
        };
      if (d.amount_usd > policy.limits.pay_usd_without_approval)
        return {
          rule: "limits.pay_usd_without_approval",
          refuse: null,
          needsRole: policy.approver_role,
        };
    } else if (d.amount_usd > policy.limits.dispute_usd_without_approval)
      return {
        rule: "limits.dispute_usd_without_approval",
        refuse: null,
        needsRole: policy.approver_role,
      };
    return { rule: null, refuse: null, needsRole: null };
  }

  const round = (n: number) => Math.round(n * 1e8) / 1e8;
  function board() {
    const jobs = store.all();
    const tenants = [...new Set(jobs.map((j) => j.tenant))];
    const row = (js: Job[]) => {
      const outcomes = js.filter((j) => j.status === "done").length;
      const counted = o.countFailedRuns ? js : js.filter((j) => j.status === "done");
      const spend = counted.reduce((a, j) => a + (j.spend_usd ?? 0), 0);
      const unknown = js.some((j) => j.steps?.cost_unknown);
      return {
        outcomes,
        spend_usd: unknown ? null : round(spend),
        cost_per_outcome_usd: outcomes && !unknown ? round(spend / outcomes) : null,
      };
    };
    return {
      tenants: tenants.map((tenant) => {
        const js = jobs.filter((j) => j.tenant === tenant);
        return { tenant, ...row(js), by_employee: [{ employee: NAME, ...row(js) }] };
      }),
      incidents: incidents.map((i) => ({ ...i, status: i.closed_at ? "closed" : "open" })),
    };
  }

  const json = (data: unknown, status = 200) => Response.json(data, { status });
  const server = Bun.serve({
    port,
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (req.method === "GET" && url.pathname === "/health")
        return json({ contract: "1", employee: NAME, tenants: TENANTS });
      if (req.method === "POST" && url.pathname === "/jobs") {
        const b: any = await req.json().catch(() => null);
        if (!b?.job_id || !b?.tenant || !b?.input?.invoice_id)
          return json(
            { error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' },
            400,
          );
        if (!TENANTS.includes(b.tenant))
          return json({ error: `this employee does not work for ${b.tenant}` }, 400);
        const seen = store.get(b.job_id);
        if (seen) return json({ job_id: seen.job_id, run_id: seen.run_id }, 200);
        const at = new Date().toISOString();
        const runId = `run-${randomUUID().slice(0, 8)}`;
        store.insert({
          job_id: b.job_id,
          run_id: runId,
          tenant: b.tenant,
          trigger: b.trigger ?? { kind: "person" },
          input: b.input,
          status: "working",
          reason: null,
          column: null,
          steps: {},
          spend_usd: 0,
          summary: null,
          created_at: at,
          updated_at: at,
        });
        void runJob(b.job_id, false);
        return json({ job_id: b.job_id, run_id: runId }, 202);
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts[1]) {
        const j = store.get(decodeURIComponent(parts[1]));
        return j
          ? json({
              job_id: j.job_id,
              run_id: j.run_id,
              status: j.status,
              reason: j.reason,
              cost_usd: j.steps?.cost_unknown ? null : round(j.spend_usd),
            })
          : json({ error: "no such job" }, 404);
      }
      if (req.method === "GET" && url.pathname === "/approvals") {
        const status = url.searchParams.get("status") ?? undefined;
        return json(store.approvals(status).map(({ decided_by, ...a }) => a));
      }
      if (req.method === "POST" && parts[0] === "approvals" && parts[1])
        return decide(decodeURIComponent(parts[1]), await req.json().catch(() => ({})));
      if (req.method === "GET" && url.pathname === "/board") return json(board());
      return json({ error: "not found" }, 404);
    },
  });

  async function decide(id: string, b: any) {
    const a = store.approval(id);
    if (!a) return json({ error: "no such approval" }, 404);
    if (a.status !== "waiting") return json({ error: `already ${a.status}` }, 409);
    if (!["approve", "decline"].includes(b?.decision) || !b?.by)
      return json({ error: 'send {"decision": "approve" or "decline", "by": person id}' }, 400);
    const job = store.get(a.job_id)!;
    const person = (await world.people()).find((p) => p.person_id === b.by);
    if (!person) return json({ reason: `nobody called ${b.by} works here` }, 403);
    if (person.tenant !== job.tenant)
      return json({ reason: `${person.name} works for ${person.tenant}, not ${job.tenant}` }, 403);
    if (!person.may_approve)
      return json(
        {
          reason: `${person.name} is a ${person.role.replace("_", " ")} and may not approve or decline`,
        },
        403,
      );
    const limit = a.action === "pay_invoice" ? person.pay_limit_usd : person.dispute_limit_usd;
    if (b.decision === "approve" && limit !== null && a.amount > limit)
      return json(
        {
          reason: `USD ${a.amount.toLocaleString("en-US")} is over ${person.name}'s limit of USD ${limit.toLocaleString("en-US")}`,
        },
        403,
      );
    await tracer(traceDir, job.run_id).span(
      "x.approval",
      null,
      {
        "x.job.id": job.job_id,
        "x.tenant": job.tenant,
        "x.approval.decision": b.decision,
        "x.approval.by": b.by,
      },
      async () => {},
    );
    if (b.decision === "decline") {
      store.decide(id, "declined", b.by);
      store.update(job.job_id, {
        status: "declined",
        column: "Refused",
        reason: `Declined by ${b.by}. Nothing was written.`,
      });
      return json({ approval_id: id, status: "declined" });
    }
    store.decide(id, "approved", b.by);
    store.update(job.job_id, {
      status: "working",
      column: null,
      steps: { ...job.steps, approval: { by: b.by, at: new Date().toISOString() } },
    });
    void runJob(job.job_id, true);
    return json({ approval_id: id, status: "approved" });
  }

  let boardServer: ReturnType<typeof Bun.serve> | null = null;
  if (boardPort)
    boardServer = Bun.serve({
      port: boardPort,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/board/data")
          return json({
            board: board(),
            jobs: store.all().map(({ steps, ...j }) => j),
            approvals: store.approvals("waiting"),
          });
        if (url.pathname === "/" || url.pathname === "/board")
          return new Response(boardPage(NAME), {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        return json({ error: "not found" }, 404);
      },
    });

  for (const j of store.all()) if (j.status === "working") void runJob(j.job_id, true);

  return {
    port: server.port,
    role: setting.role,
    stop: () => {
      server.stop(true);
      boardServer?.stop(true);
    },
  };
}

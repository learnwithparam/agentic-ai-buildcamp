// Planted-fault employees for the Build part. Each step's wrong/<mistake>/employee.toml starts one
// of these, so `bun run verify --all` proves every Build check rejects the mistake.
// Run as: bun faulty.ts <mistake>
//
// naive                 the naive clerk behind the contract: pays the invoice total, retries once
//                       with a new key, says done whatever happened, starts a job again when the
//                       same job_id comes twice, no traces
// naive-script          the naive clerk as a script: it runs and exits, so nothing ever answers
//                       GET /health
// ignores-the-port      the reference, listening on a port of its own choosing instead of PORT
// retries-forever       retries every failed tool call with no step budget, so a job that cannot
//                       finish never ends
// trusts-the-draft      writes the draft it is handed (or its own) with no checker in between
// any reference fault   the reference employee with one planted fault from
//                       reference/src/employee.ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runNaive } from "../../reference/naive";
import {
  type Evidence,
  expected,
  type Invoice,
  type Load,
  type ProofOfDelivery,
  type RateConfirmation,
} from "../../reference/src/audit";
import { type Faults, startEmployee } from "../../reference/src/employee";
import type { Draft } from "../../reference/src/store";
import { tracer } from "../../reference/src/trace";
import { type CallInfo, ToolFailed, worldClient } from "../../reference/src/world";

const mistake = process.argv[2] ?? "";

const REFERENCE_FAULTS: Record<string, Partial<Faults>> = {
  "wrong-contract-version": { contractVersion: "2" },
  "skips-the-tools": { readTools: false },
  "says-done-without-paying": { readTools: false },
  "trusts-the-write-call": { settleCheck: false },
  "pays-above-the-rate": { checkRate: false },
  "maker-writes-alone": { checkRate: false },
  "pays-without-asking": { waitForApproval: false },
  "lets-anyone-approve": { checkApprover: false },
  "forgets-the-decline": {},
};

type Job = {
  job_id: string;
  run_id: string;
  tenant: string;
  input: { invoice_id?: string; draft?: Draft };
  status: string;
  reason: string | null;
};
type NewJob = { job_id: string; tenant: string; input?: Job["input"] };
type Work = (job: Job) => Promise<void>;

// The jobs one faulty employee holds, and the work it does on each.
type JobDesk = { jobs: Map<string, Job>; work: Work; dedupe: boolean };

function startJob(desk: JobDesk, body: NewJob): Response {
  const job: Job = {
    job_id: body.job_id,
    run_id: `run-${randomUUID().slice(0, 8)}`,
    tenant: body.tenant,
    input: body.input ?? {},
    status: "working",
    reason: null,
  };
  desk.jobs.set(job.job_id, job);
  void desk.work(job);
  return Response.json({ job_id: job.job_id, run_id: job.run_id }, { status: 202 });
}

function jobAnswer(job: Job | undefined): Response {
  if (!job) return Response.json({ error: "no such job" }, { status: 404 });
  return Response.json({
    job_id: job.job_id,
    run_id: job.run_id,
    status: job.status,
    reason: job.reason,
    cost_usd: 0,
  });
}

// POST /jobs and GET /jobs/<job_id>, or null for any other request.
// With dedupe false, the same job_id sent twice starts a second run: a planted mistake.
async function answerJobs(request: Request, desk: JobDesk): Promise<Response | null> {
  const url = new URL(request.url);
  const [section, id] = url.pathname.split("/").filter(Boolean);
  if (request.method === "POST" && url.pathname === "/jobs") {
    const body = (await request.json().catch(() => ({}))) as NewJob;
    const seen = desk.jobs.get(body.job_id);
    if (seen && desk.dedupe) return Response.json({ job_id: seen.job_id, run_id: seen.run_id });
    return startJob(desk, body);
  }
  if (request.method === "GET" && section === "jobs" && id)
    return jobAnswer(desk.jobs.get(decodeURIComponent(id)));
  return null;
}

// A bare contract server for the hand-written faulty employees below.
function serve(name: string, work: Work, options: { dedupe: boolean }) {
  const desk: JobDesk = { jobs: new Map<string, Job>(), work, dedupe: options.dedupe };
  return Bun.serve({
    port: Number(process.env.PORT ?? 7701),
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/health")
        return Response.json({
          contract: "1",
          employee: name,
          tenants: ["kaas-freight", "kaas-dairy"],
        });
      const jobsAnswer = await answerJobs(request, desk);
      if (jobsAnswer) return jobsAnswer;
      if (url.pathname === "/approvals" && request.method === "GET") return Response.json([]);
      if (url.pathname === "/board") return Response.json({ tenants: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

const world = () => worldClient(process.env.WORLD_URL ?? "http://localhost:7700");
type WorldClient = ReturnType<typeof world>;
const traceDir = () => process.env.TRACE_DIR ?? join(process.cwd(), "traces");

// The mistake: a new key on every try, so a payment that landed but timed out is paid again.
async function payWithNewKeyEachTry(client: WorldClient, invoice: Invoice, info: CallInfo) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      await client.call(
        "pay_invoice",
        { invoice_id: invoice.invoice_id, amount_usd: invoice.total_usd },
        { ...info, key: randomUUID() },
      );
      return;
    } catch (error) {
      if (!(error instanceof ToolFailed)) throw error;
    }
  }
}

// The naive clerk: pay the total with a new key on every try, then say done whatever happened.
function startNaiveClerk() {
  const client = world();
  serve(
    "naive-clerk",
    async (job) => {
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "naive-clerk" };
      try {
        const byInvoice = { invoice_id: job.input.invoice_id };
        const invoice = await client.call<Invoice>("read_invoice", byInvoice, info);
        await payWithNewKeyEachTry(client, invoice, info);
      } catch {}
      job.status = "done";
      job.reason = "Paid. Done.";
    },
    { dedupe: false },
  );
}

// The retrying clerk: every call tries again until it works, with no step budget.
function startRetryingClerk() {
  const client = world();
  serve(
    "retrying-clerk",
    async (job) => {
      const trace = tracer(traceDir(), job.run_id);
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "retrying-clerk" };
      const callUntilItWorks = async <Reply>(
        tool: string,
        args: Record<string, unknown>,
        key?: string,
      ): Promise<Reply> => {
        const attributes = { "gen_ai.tool.name": tool, "x.side_effect": key ? "write" : "none" };
        for (;;) {
          try {
            return await trace.span("execute_tool", null, attributes, () =>
              client.call<Reply>(tool, args, { ...info, key }),
            );
          } catch {
            await Bun.sleep(100);
          }
        }
      };
      const byInvoice = { invoice_id: job.input.invoice_id };
      const invoice = await callUntilItWorks<Invoice>("read_invoice", byInvoice);
      await callUntilItWorks(
        "pay_invoice",
        { invoice_id: invoice.invoice_id, amount_usd: invoice.total_usd },
        `${job.tenant}:${invoice.invoice_id}:pay`,
      );
      job.status = "done";
      job.reason = "Paid.";
    },
    { dedupe: true },
  );
}

type CallTool = <Reply>(
  name: string,
  args: Record<string, unknown>,
  key?: string,
) => Promise<Reply>;

async function readEvidence(job: Job, callTool: CallTool): Promise<Evidence> {
  const invoice = await callTool<Invoice>("read_invoice", { invoice_id: job.input.invoice_id });
  const byLoad = { load_id: invoice.load_id };
  const load = await callTool<Load>("find_load", byLoad);
  const rate = await callTool<RateConfirmation>("read_rate_confirmation", byLoad);
  const proof = await callTool<ProofOfDelivery>("read_proof_of_delivery", byLoad);
  return { invoice, load, rate, pod: proof };
}

// The mistake: whatever the draft says is written, with no checker in between.
async function writeTheDraft(job: Job, callTool: CallTool) {
  const evidence = await readEvidence(job, callTool);
  const invoiceId = evidence.invoice.invoice_id;
  const draft = job.input.draft ?? expected(evidence);
  const key = `${job.tenant}:${invoiceId}:${draft.action}`;
  if (draft.action === "pay")
    await callTool("pay_invoice", { invoice_id: invoiceId, amount_usd: draft.amount_usd }, key);
  else
    await callTool(
      "open_dispute",
      {
        invoice_id: invoiceId,
        reason_code: draft.reason_code,
        amount_usd: draft.amount_usd,
        note: draft.note ?? "",
      },
      key,
    );
  job.status = "done";
  job.reason = `Wrote the draft: ${draft.action} ${draft.reason_code ?? ""}`.trim();
}

// The trusting clerk: reads the evidence, then writes the draft it was handed, or its own.
function startTrustingClerk() {
  const client = world();
  serve(
    "trusting-clerk",
    async (job) => {
      const trace = tracer(traceDir(), job.run_id);
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "trusting-clerk" };
      const attributes = {
        "gen_ai.agent.name": "trusting-clerk",
        "x.job.id": job.job_id,
        "x.tenant": job.tenant,
      };
      await trace.span("invoke_agent", null, attributes, async (root) => {
        const callTool: CallTool = (name, args, key) => {
          const toolAttributes = {
            "gen_ai.tool.name": name,
            "x.side_effect": key ? "write" : "none",
            ...(key ? { "x.idempotency_key": key } : {}),
          };
          return trace.span("execute_tool", root, toolAttributes, () =>
            client.call(name, args, { ...info, key }),
          );
        };
        try {
          await writeTheDraft(job, callTool);
        } catch (error) {
          job.status = "failed";
          job.reason = (error as Error).message;
        }
      });
    },
    { dedupe: true },
  );
}

if (mistake in REFERENCE_FAULTS) {
  startEmployee(REFERENCE_FAULTS[mistake]);
} else if (mistake === "ignores-the-port") {
  process.env.PORT = "0";
  startEmployee();
} else if (mistake === "naive-script") {
  console.log(await runNaive(process.env.WORLD_URL ?? "http://localhost:7700", []));
  process.exit(0);
} else if (mistake === "naive") {
  startNaiveClerk();
} else if (mistake === "retries-forever") {
  startRetryingClerk();
} else if (mistake === "trusts-the-draft") {
  startTrustingClerk();
} else {
  console.log(`faulty.ts has no mistake called "${mistake}".`);
  process.exit(1);
}

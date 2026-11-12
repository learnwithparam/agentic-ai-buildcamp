// Planted-fault employees for the Build part. Each step's wrong/<mistake>/employee.toml starts one of these, so
// `bun run verify --all` proves every Build check rejects the mistake. Run as: bun faulty.ts <mistake>
//
// naive                 the naive clerk behind the contract: pays the invoice total, retries once with a new key,
//                       says done whatever happened, starts a job again when the same job_id comes twice, no traces
// naive-script          the naive clerk as a script: it runs and exits, so nothing ever answers GET /health
// ignores-the-port      the reference, listening on a port of its own choosing instead of PORT
// retries-forever       retries every failed tool call with no step budget, so a job that cannot finish never ends
// trusts-the-draft      writes the draft it is handed (or its own) with no checker in between
// any reference fault   the reference employee with one planted fault from reference/src/employee.ts
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runNaive } from "../../reference/naive";
import { expected } from "../../reference/src/audit";
import { type Faults, startEmployee } from "../../reference/src/employee";
import { tracer } from "../../reference/src/trace";
import { ToolFailed, worldClient } from "../../reference/src/world";

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
  input: any;
  status: string;
  reason: string | null;
};

// A bare contract server for the hand-written faulty employees below.
function serve(name: string, work: (job: Job) => Promise<void>, opts: { dedupe: boolean }) {
  const jobs = new Map<string, Job>();
  return Bun.serve({
    port: Number(process.env.PORT ?? 7701),
    idleTimeout: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const parts = url.pathname.split("/").filter(Boolean);
      if (url.pathname === "/health")
        return Response.json({
          contract: "1",
          employee: name,
          tenants: ["kaas-freight", "kaas-dairy"],
        });
      if (req.method === "POST" && url.pathname === "/jobs") {
        const b: any = await req.json().catch(() => ({}));
        const seen = jobs.get(b.job_id);
        if (seen && opts.dedupe) return Response.json({ job_id: seen.job_id, run_id: seen.run_id });
        const job: Job = {
          job_id: b.job_id,
          run_id: `run-${randomUUID().slice(0, 8)}`,
          tenant: b.tenant,
          input: b.input ?? {},
          status: "working",
          reason: null,
        };
        jobs.set(job.job_id, job);
        void work(job);
        return Response.json({ job_id: job.job_id, run_id: job.run_id }, { status: 202 });
      }
      if (req.method === "GET" && parts[0] === "jobs" && parts[1]) {
        const j = jobs.get(decodeURIComponent(parts[1]));
        return j
          ? Response.json({
              job_id: j.job_id,
              run_id: j.run_id,
              status: j.status,
              reason: j.reason,
              cost_usd: 0,
            })
          : Response.json({ error: "no such job" }, { status: 404 });
      }
      if (url.pathname === "/approvals" && req.method === "GET") return Response.json([]);
      if (url.pathname === "/board") return Response.json({ tenants: [] });
      return Response.json({ error: "not found" }, { status: 404 });
    },
  });
}

const world = () => worldClient(process.env.WORLD_URL ?? "http://localhost:7700");
const traceDir = () => process.env.TRACE_DIR ?? join(process.cwd(), "traces");

if (mistake in REFERENCE_FAULTS) {
  startEmployee(REFERENCE_FAULTS[mistake]);
} else if (mistake === "ignores-the-port") {
  process.env.PORT = "0";
  startEmployee();
} else if (mistake === "naive-script") {
  console.log(await runNaive(process.env.WORLD_URL ?? "http://localhost:7700", []));
  process.exit(0);
} else if (mistake === "naive") {
  const w = world();
  serve(
    "naive-clerk",
    async (job) => {
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "naive-clerk" };
      try {
        const inv = await w.call("read_invoice", { invoice_id: job.input.invoice_id }, info);
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            await w.call(
              "pay_invoice",
              { invoice_id: inv.invoice_id, amount_usd: inv.total_usd },
              { ...info, key: randomUUID() },
            );
            break;
          } catch (e) {
            if (!(e instanceof ToolFailed)) throw e;
          }
        }
      } catch {}
      job.status = "done";
      job.reason = "Paid. Done.";
    },
    { dedupe: false },
  );
} else if (mistake === "retries-forever") {
  const w = world();
  serve(
    "retrying-clerk",
    async (job) => {
      const t = tracer(traceDir(), job.run_id);
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "retrying-clerk" };
      const call = async (tool: string, args: any, key?: string) => {
        for (;;) {
          try {
            return await t.span(
              "execute_tool",
              null,
              { "gen_ai.tool.name": tool, "x.side_effect": key ? "write" : "none" },
              () => w.call(tool, args, { ...info, key }),
            );
          } catch {
            await Bun.sleep(100);
          }
        }
      };
      const inv = await call("read_invoice", { invoice_id: job.input.invoice_id });
      await call(
        "pay_invoice",
        { invoice_id: inv.invoice_id, amount_usd: inv.total_usd },
        `${job.tenant}:${inv.invoice_id}:pay`,
      );
      job.status = "done";
      job.reason = "Paid.";
    },
    { dedupe: true },
  );
} else if (mistake === "trusts-the-draft") {
  const w = world();
  serve(
    "trusting-clerk",
    async (job) => {
      const t = tracer(traceDir(), job.run_id);
      const info = { tenant: job.tenant, job_id: job.job_id, employee: "trusting-clerk" };
      await t.span(
        "invoke_agent",
        null,
        { "gen_ai.agent.name": "trusting-clerk", "x.job.id": job.job_id, "x.tenant": job.tenant },
        async (root) => {
          const tool = (name: string, args: any, key?: string) =>
            t.span(
              "execute_tool",
              root,
              {
                "gen_ai.tool.name": name,
                "x.side_effect": key ? "write" : "none",
                ...(key ? { "x.idempotency_key": key } : {}),
              },
              () => w.call(name, args, { ...info, key }),
            );
          try {
            const invoice = await tool("read_invoice", { invoice_id: job.input.invoice_id });
            const load = await tool("find_load", { load_id: invoice.load_id });
            const rate = await tool("read_rate_confirmation", { load_id: invoice.load_id });
            const pod = await tool("read_proof_of_delivery", { load_id: invoice.load_id });
            const d: any = job.input.draft ?? expected({ invoice, load, rate, pod });
            const key = `${job.tenant}:${invoice.invoice_id}:${d.action}`;
            if (d.action === "pay")
              await tool(
                "pay_invoice",
                { invoice_id: invoice.invoice_id, amount_usd: d.amount_usd },
                key,
              );
            else
              await tool(
                "open_dispute",
                {
                  invoice_id: invoice.invoice_id,
                  reason_code: d.reason_code,
                  amount_usd: d.amount_usd,
                  note: d.note ?? "",
                },
                key,
              );
            job.status = "done";
            job.reason = `Wrote the draft: ${d.action} ${d.reason_code ?? ""}`.trim();
          } catch (e) {
            job.status = "failed";
            job.reason = (e as Error).message;
          }
        },
      );
    },
    { dedupe: true },
  );
} else {
  console.log(`faulty.ts has no mistake called "${mistake}".`);
  process.exit(1);
}

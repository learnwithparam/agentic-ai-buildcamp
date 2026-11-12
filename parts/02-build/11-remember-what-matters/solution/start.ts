// A memory layer around the reference employee. It answers the contract on PORT and passes jobs to the
// reference running inside the same process. It remembers one kind of fact the ledger cannot give back:
// a person declined an invoice. A decline writes nothing, so without memory the next job asks Lena again.
//
// Memory lives in STATE_DIR/memory.json, so it survives a restart. Every fact carries its tenant, and a read
// only ever looks at the job's own tenant. Each read and write is a span named x.memory in the run's trace.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startEmployee } from "../../../../reference/src/employee";
import { tracer } from "../../../../reference/src/trace";

type Fact = { tenant: string; invoice_id: string; fact: "declined"; by: string; job_id: string };
type LocalJob = { job_id: string; run_id: string; tenant: string; status: string; reason: string };
type Memory = { facts: Fact[]; jobs: Record<string, { tenant: string; invoice_id: string; run_id: string }>; local: Record<string, LocalJob> };

const outerPort = Number(process.env.PORT ?? 7701);
const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
const traceDir = process.env.TRACE_DIR ?? join(process.cwd(), "traces");
mkdirSync(stateDir, { recursive: true });

// The reference runs on a free inner port with its own state folder.
process.env.PORT = "0";
process.env.STATE_DIR = join(stateDir, "inner");
const inner = startEmployee();
const INNER = `http://localhost:${inner.port}`;

const file = join(stateDir, "memory.json");
const load = (): Memory => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { facts: [], jobs: {}, local: {} });
const save = (m: Memory) => writeFileSync(file, JSON.stringify(m, null, 2));

// Read only the job's own tenant. A fact from another tenant is never even looked at.
const recall = (m: Memory, tenant: string, invoiceId: string) => m.facts.find((f) => f.tenant === tenant && f.invoice_id === invoiceId) ?? null;

const memorySpan = (runId: string, attrs: Record<string, string | boolean>) =>
  tracer(traceDir, runId).span("x.memory", null, attrs, async () => {});

const forward = (req: Request, path: string, body?: string) =>
  fetch(INNER + path, { method: req.method, headers: { "content-type": "application/json" }, body });

Bun.serve({
  port: outerPort,
  idleTimeout: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const parts = url.pathname.split("/").filter(Boolean);

    if (req.method === "POST" && url.pathname === "/jobs") {
      const text = await req.text();
      const b: any = JSON.parse(text || "{}");
      const m = load();
      const mine = m.local[b.job_id];
      if (mine) return Response.json({ job_id: mine.job_id, run_id: mine.run_id });
      const invoiceId = b?.input?.invoice_id;
      const fact = b?.tenant && invoiceId ? recall(m, b.tenant, invoiceId) : null;
      if (fact) {
        // Lena already said no. Do not ask her twice, and write nothing.
        const run_id = `run-${randomUUID().slice(0, 8)}`;
        const reason = `${invoiceId} was declined by ${fact.by} on job ${fact.job_id}. Not asking again. Nothing was written.`;
        const t = tracer(traceDir, run_id);
        await t.span("invoke_agent", null, { "gen_ai.agent.name": "freight-audit-clerk", "x.job.id": b.job_id, "x.tenant": b.tenant, "x.trigger.kind": b.trigger?.kind ?? "person", "x.outcome": "declined" }, async (root) => {
          await t.span("x.memory", root, { "x.memory.op": "read", "x.tenant": b.tenant, "x.memory.key": invoiceId, "x.memory.hit": true }, async () => {});
        });
        m.local[b.job_id] = { job_id: b.job_id, run_id, tenant: b.tenant, status: "declined", reason };
        save(m);
        return Response.json({ job_id: b.job_id, run_id }, { status: 202 });
      }
      const r = await forward(req, "/jobs", text);
      const out: any = await r.json();
      if (out?.run_id && invoiceId) {
        await memorySpan(out.run_id, { "x.memory.op": "read", "x.tenant": b.tenant, "x.memory.key": invoiceId, "x.memory.hit": false });
        m.jobs[b.job_id] = { tenant: b.tenant, invoice_id: invoiceId, run_id: out.run_id };
        save(m);
      }
      return Response.json(out, { status: r.status });
    }

    if (req.method === "GET" && parts[0] === "jobs" && parts[1]) {
      const mine = load().local[decodeURIComponent(parts[1])];
      if (mine) return Response.json({ job_id: mine.job_id, run_id: mine.run_id, status: mine.status, reason: mine.reason, cost_usd: 0 });
    }

    if (req.method === "POST" && parts[0] === "approvals" && parts[1]) {
      const text = await req.text();
      const b: any = JSON.parse(text || "{}");
      const id = decodeURIComponent(parts[1]);
      const all = (await (await fetch(`${INNER}/approvals`)).json()) as any[];
      const approval = all.find((a) => a.approval_id === id);
      const r = await forward(req, url.pathname, text);
      const out = await r.json();
      if (r.status === 200 && b.decision === "decline" && approval) {
        const m = load();
        const job = m.jobs[approval.job_id];
        if (job) {
          m.facts.push({ tenant: job.tenant, invoice_id: job.invoice_id, fact: "declined", by: b.by, job_id: approval.job_id });
          save(m);
          await memorySpan(job.run_id, { "x.memory.op": "write", "x.tenant": job.tenant, "x.memory.key": job.invoice_id, "x.memory.hit": false });
        }
      }
      return Response.json(out, { status: r.status });
    }

    const r = await forward(req, url.pathname + url.search, req.method === "GET" ? undefined : await req.text());
    return new Response(r.body, { status: r.status, headers: { "content-type": "application/json" } });
  },
});
console.log(`freight-audit-clerk with memory answers contract 1 on http://localhost:${outerPort}`);

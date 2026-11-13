// A memory layer around the reference employee. It answers the contract on PORT and passes jobs
// to the reference running inside the same process. It remembers one kind of fact the ledger
// cannot give back: a person declined an invoice. A decline writes nothing, so without memory the
// next job asks Lena again.
//
// Memory lives in STATE_DIR/memory.json, so it survives a restart. Every fact carries its tenant,
// and a read only ever looks at the job's own tenant. Each read and write is a span named x.memory
// in the run's trace.
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// The repo folder that holds reference/. This file looks for it by walking up from its own
// folder, so it works here and also when you copy it into employee/.
function findRepoRoot(): string {
  let folder = import.meta.dir;
  while (!existsSync(join(folder, "reference", "start.ts"))) {
    const parent = dirname(folder);
    if (parent === folder)
      throw new Error("No reference/ folder above this file. Run it inside the repo.");
    folder = parent;
  }
  return folder;
}

const referenceCode = join(findRepoRoot(), "reference", "src");
const { startEmployee } = await import(join(referenceCode, "employee.ts"));
const { tracer } = await import(join(referenceCode, "trace.ts"));

type Fact = { tenant: string; invoice_id: string; fact: "declined"; by: string; job_id: string };
type LocalJob = { job_id: string; run_id: string; tenant: string; status: string; reason: string };
type Memory = {
  facts: Fact[];
  jobs: Record<string, { tenant: string; invoice_id: string; run_id: string }>;
  local: Record<string, LocalJob>;
};
type NewJob = {
  job_id: string;
  tenant: string;
  trigger?: { kind?: string };
  input?: { invoice_id?: string };
};
type Approval = { approval_id: string; job_id: string };
type MemoryAttributes = Record<string, string | boolean>;

const outerPort = Number(process.env.PORT ?? 7701);
const stateDir = process.env.STATE_DIR ?? join(process.cwd(), ".state");
const traceDir = process.env.TRACE_DIR ?? join(process.cwd(), "traces");
mkdirSync(stateDir, { recursive: true });

// The reference runs on a free inner port with its own state folder.
process.env.PORT = "0";
process.env.STATE_DIR = join(stateDir, "inner");
const inner = startEmployee();
const INNER = `http://localhost:${inner.port}`;

const memoryFile = join(stateDir, "memory.json");

function loadMemory(): Memory {
  if (!existsSync(memoryFile)) return { facts: [], jobs: {}, local: {} };
  return JSON.parse(readFileSync(memoryFile, "utf8"));
}

const saveMemory = (memory: Memory) => writeFileSync(memoryFile, JSON.stringify(memory, null, 2));

// Read only the job's own tenant. A fact from another tenant is never even looked at.
function recall(memory: Memory, tenant: string, invoiceId: string): Fact | null {
  const matches = (fact: Fact) => fact.tenant === tenant && fact.invoice_id === invoiceId;
  return memory.facts.find(matches) ?? null;
}

const memorySpan = (runId: string, attributes: MemoryAttributes) =>
  tracer(traceDir, runId).span("x.memory", null, attributes, async () => {});

const forward = (request: Request, path: string, body?: string) =>
  fetch(INNER + path, {
    method: request.method,
    headers: { "content-type": "application/json" },
    body,
  });

// Lena already said no. Do not ask her twice, and write nothing.
async function answerFromMemory(memory: Memory, job: NewJob, fact: Fact, invoiceId: string) {
  const runId = `run-${randomUUID().slice(0, 8)}`;
  const reason =
    `${invoiceId} was declined by ${fact.by} on job ${fact.job_id}. ` +
    "Not asking again. Nothing was written.";
  const trace = tracer(traceDir, runId);
  const jobAttributes = {
    "gen_ai.agent.name": "freight-audit-clerk",
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.trigger.kind": job.trigger?.kind ?? "person",
    "x.outcome": "declined",
  };
  const readAttributes = {
    "x.memory.op": "read",
    "x.tenant": job.tenant,
    "x.memory.key": invoiceId,
    "x.memory.hit": true,
  };
  await trace.span("invoke_agent", null, jobAttributes, async (root) => {
    await trace.span("x.memory", root, readAttributes, async () => {});
  });
  memory.local[job.job_id] = {
    job_id: job.job_id,
    run_id: runId,
    tenant: job.tenant,
    status: "declined",
    reason,
  };
  saveMemory(memory);
  return Response.json({ job_id: job.job_id, run_id: runId }, { status: 202 });
}

async function startJob(request: Request): Promise<Response> {
  const text = await request.text();
  const job: NewJob = JSON.parse(text || "{}");
  const memory = loadMemory();
  const answered = memory.local[job.job_id];
  if (answered) return Response.json({ job_id: answered.job_id, run_id: answered.run_id });
  const invoiceId = job?.input?.invoice_id;
  const fact = job?.tenant && invoiceId ? recall(memory, job.tenant, invoiceId) : null;
  if (fact && invoiceId) return answerFromMemory(memory, job, fact, invoiceId);
  const innerResponse = await forward(request, "/jobs", text);
  const started: { run_id?: string } = await innerResponse.json();
  if (started?.run_id && invoiceId) {
    await memorySpan(started.run_id, {
      "x.memory.op": "read",
      "x.tenant": job.tenant,
      "x.memory.key": invoiceId,
      "x.memory.hit": false,
    });
    memory.jobs[job.job_id] = {
      tenant: job.tenant,
      invoice_id: invoiceId,
      run_id: started.run_id,
    };
    saveMemory(memory);
  }
  return Response.json(started, { status: innerResponse.status });
}

function rememberDecline(approval: Approval, decidedBy: string) {
  const memory = loadMemory();
  const job = memory.jobs[approval.job_id];
  if (!job) return null;
  memory.facts.push({
    tenant: job.tenant,
    invoice_id: job.invoice_id,
    fact: "declined",
    by: decidedBy,
    job_id: approval.job_id,
  });
  saveMemory(memory);
  return memorySpan(job.run_id, {
    "x.memory.op": "write",
    "x.tenant": job.tenant,
    "x.memory.key": job.invoice_id,
    "x.memory.hit": false,
  });
}

async function decide(request: Request, url: URL, approvalId: string): Promise<Response> {
  const text = await request.text();
  const answer: { decision?: string; by: string } = JSON.parse(text || "{}");
  const waiting = (await (await fetch(`${INNER}/approvals`)).json()) as Approval[];
  const approval = waiting.find((candidate) => candidate.approval_id === approvalId);
  const innerResponse = await forward(request, url.pathname, text);
  const decided = await innerResponse.json();
  const declined = innerResponse.status === 200 && answer.decision === "decline";
  if (declined && approval) await rememberDecline(approval, answer.by);
  return Response.json(decided, { status: innerResponse.status });
}

function rememberedJob(jobId: string): Response | null {
  const answered = loadMemory().local[jobId];
  if (!answered) return null;
  return Response.json({
    job_id: answered.job_id,
    run_id: answered.run_id,
    status: answered.status,
    reason: answered.reason,
    cost_usd: 0,
  });
}

async function passThrough(request: Request, url: URL): Promise<Response> {
  const body = request.method === "GET" ? undefined : await request.text();
  const innerResponse = await forward(request, url.pathname + url.search, body);
  return new Response(innerResponse.body, {
    status: innerResponse.status,
    headers: { "content-type": "application/json" },
  });
}

Bun.serve({
  port: outerPort,
  idleTimeout: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const [section, id] = url.pathname.split("/").filter(Boolean);
    if (request.method === "POST" && url.pathname === "/jobs") return startJob(request);
    if (request.method === "GET" && section === "jobs" && id) {
      const answered = rememberedJob(decodeURIComponent(id));
      if (answered) return answered;
    }
    if (request.method === "POST" && section === "approvals" && id)
      return decide(request, url, decodeURIComponent(id));
    return passThrough(request, url);
  },
});
console.log(`freight-audit-clerk with memory answers contract 1 on http://localhost:${outerPort}`);

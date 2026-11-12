// The contract server: the six routes of contract version 1. Run it with `bun start.ts`.
import { randomUUID } from "node:crypto";
import { runJob } from "./src/agent";
import { type JobInput, jobs, type Trigger } from "./src/jobs";

export const NAME = "freight-audit-clerk";
const port = Number(process.env.PORT ?? 7701);

type JobRequest = { job_id: string; tenant: string; trigger?: Trigger; input: JobInput };

function reply(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function isJobRequest(body: unknown): body is JobRequest {
  const request = body as Partial<JobRequest> | null;
  return Boolean(request?.job_id && request.tenant && request.input?.invoice_id);
}

async function startJob(request: Request): Promise<Response> {
  const body: unknown = await request.json().catch(() => null);
  if (!isJobRequest(body)) {
    return reply({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
  }
  // The same job twice starts nothing new.
  const seen = jobs.get(body.job_id);
  if (seen) return reply({ job_id: seen.job_id, run_id: seen.run_id }, 200);
  const job = jobs.add({
    job_id: body.job_id,
    run_id: `run-${randomUUID().slice(0, 8)}`,
    tenant: body.tenant,
    trigger: body.trigger ?? { kind: "person" },
    input: body.input,
  });
  void runJob(job);
  return reply({ job_id: job.job_id, run_id: job.run_id }, 202);
}

function readJob(jobId: string): Response {
  const job = jobs.get(decodeURIComponent(jobId));
  if (!job) return reply({ error: "no such job" }, 404);
  return reply({ status: job.status, reason: job.reason, cost_usd: job.cost_usd });
}

function board(): Response {
  const allJobs = jobs.all();
  const outcomes = allJobs.filter((job) => job.status === "done").length;
  const spend = allJobs.reduce((total, job) => total + job.cost_usd, 0);
  const row = {
    outcomes,
    spend_usd: spend,
    cost_per_outcome_usd: outcomes ? spend / outcomes : null,
  };
  return reply({
    tenants: [{ tenant: "kaas-freight", ...row, by_employee: [{ employee: NAME, ...row }] }],
  });
}

// Routes with a fixed path, found by "METHOD /path".
const fixedRoutes: Record<string, (request: Request) => Response | Promise<Response>> = {
  "GET /health": () => reply({ contract: "1", employee: NAME, tenants: ["kaas-freight"] }),
  "POST /jobs": startJob,
  // Approvals arrive in the Build part (ask-for-approval). Until then there are none to list.
  "GET /approvals": () => reply([]),
  "GET /board": board,
};

function route(request: Request): Response | Promise<Response> {
  const url = new URL(request.url);
  const fixedRoute = fixedRoutes[`${request.method} ${url.pathname}`];
  if (fixedRoute) return fixedRoute(request);

  const [collection, id] = url.pathname.split("/").filter(Boolean);
  if (request.method === "GET" && collection === "jobs" && id) return readJob(id);
  // Until approvals arrive there are none to decide either.
  if (request.method === "POST" && collection === "approvals") {
    return reply({ error: "no such approval" }, 404);
  }
  return reply({ error: "not found" }, 404);
}

const server = Bun.serve({ port, fetch: route });
console.log(`${NAME} answers contract 1 on http://localhost:${server.port}`);

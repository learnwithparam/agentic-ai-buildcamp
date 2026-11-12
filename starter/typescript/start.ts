// The contract server: the six routes of contract version 1. Run it with `bun start.ts`.
import { randomUUID } from "node:crypto";
import { jobs } from "./src/jobs";
import { runJob } from "./src/agent";

export const NAME = "freight-audit-clerk";
const port = Number(process.env.PORT ?? 7701);
const json = (data: unknown, status = 200) => Response.json(data, { status });

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    const [first, id] = url.pathname.split("/").filter(Boolean);

    if (req.method === "GET" && url.pathname === "/health") return json({ contract: "1", employee: NAME, tenants: ["kaas-freight"] });

    if (req.method === "POST" && url.pathname === "/jobs") {
      const b: any = await req.json().catch(() => null);
      if (!b?.job_id || !b?.tenant || !b?.input?.invoice_id) return json({ error: 'send {"job_id", "tenant", "trigger", "input": {"invoice_id"}}' }, 400);
      const seen = jobs.get(b.job_id);
      if (seen) return json({ job_id: seen.job_id, run_id: seen.run_id }, 200); // the same job twice starts nothing new
      const job = jobs.add({ job_id: b.job_id, run_id: `run-${randomUUID().slice(0, 8)}`, tenant: b.tenant, trigger: b.trigger ?? { kind: "person" }, input: b.input });
      void runJob(job);
      return json({ job_id: job.job_id, run_id: job.run_id }, 202);
    }

    if (req.method === "GET" && first === "jobs" && id) {
      const j = jobs.get(decodeURIComponent(id));
      return j ? json({ status: j.status, reason: j.reason, cost_usd: j.cost_usd }) : json({ error: "no such job" }, 404);
    }

    // Approvals arrive in the Build part (ask-for-approval). Until then there are none to list or decide.
    if (req.method === "GET" && url.pathname === "/approvals") return json([]);
    if (req.method === "POST" && first === "approvals") return json({ error: "no such approval" }, 404);

    if (req.method === "GET" && url.pathname === "/board") {
      const all = jobs.all();
      const outcomes = all.filter((j) => j.status === "done").length;
      const spend = all.reduce((a, j) => a + j.cost_usd, 0);
      const row = { outcomes, spend_usd: spend, cost_per_outcome_usd: outcomes ? spend / outcomes : null };
      return json({ tenants: [{ tenant: "kaas-freight", ...row, by_employee: [{ employee: NAME, ...row }] }] });
    }
    return json({ error: "not found" }, 404);
  },
});
console.log(`${NAME} answers contract 1 on http://localhost:${server.port}`);

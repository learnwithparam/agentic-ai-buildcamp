// The job loop. Today it reads the evidence and asks the model for a draft. Paying is your next step.
import { jobs, type Job } from "./jobs";
import { tool } from "./tools";
import { tracer } from "./trace";
import { ask, canAsk } from "./model";

const SYSTEM = `You audit carrier invoices. Given an invoice, its load, the rate confirmation and the proof of delivery,
reply with one JSON object: {"action": "pay" or "dispute", "amount_usd": number, "reason_code": string or null, "note": string}.`;

export async function runJob(job: Job) {
  const span = tracer(job.run_id);
  const ctx = { tenant: job.tenant, job_id: job.job_id };
  await span("invoke_agent", null, { "gen_ai.agent.name": "freight-audit-clerk", "x.job.id": job.job_id, "x.tenant": job.tenant, "x.trigger.kind": job.trigger.kind }, async (root, setRoot) => {
    const call = (name: string, args: Record<string, unknown>) =>
      span("execute_tool", root, { "gen_ai.tool.name": name, "gen_ai.tool.call.id": crypto.randomUUID(), "x.side_effect": "none" }, () => tool(name, args, ctx));
    try {
      // 1. Read the evidence.
      const invoice = await call("read_invoice", { invoice_id: job.input.invoice_id });
      const load = await call("find_load", { load_id: invoice.load_id });
      const rate = await call("read_rate_confirmation", { load_id: invoice.load_id });
      const pod = await call("read_proof_of_delivery", { load_id: invoice.load_id });

      // 2. Ask the model for a draft, if there is a key.
      const draft = !(await canAsk()) ? null : await span("chat", root, {}, async (_id, set) => {
        const r = await ask(SYSTEM, JSON.stringify({ invoice, load, rate, pod }));
        if (r) set({ "gen_ai.request.model": r.model, "gen_ai.usage.input_tokens": r.input_tokens, "gen_ai.usage.output_tokens": r.output_tokens });
        return r?.text ?? null;
      });

      // 3. TODO (pay-one-invoice): decide, call pay_invoice with an Idempotency-Key, read the ledger, then report done.
      jobs.set(job.job_id, { status: "stopped", reason: `Read the evidence for ${invoice.invoice_id}. ${draft ? `Draft: ${draft}` : "No model key, so no draft."} Paying comes next.` });
      setRoot({ "x.outcome": "stopped" });
    } catch (e) {
      jobs.set(job.job_id, { status: "failed", reason: (e as Error).message });
      setRoot({ "x.outcome": "failed" });
    }
  });
}

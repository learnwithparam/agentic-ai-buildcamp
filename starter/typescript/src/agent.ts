// The job loop. Today it reads the evidence and asks the model for a draft.
// Paying is your next step.
import { type Job, jobs } from "./jobs";
import { ask, canAsk } from "./model";
import { type ToolAnswer, tool } from "./tools";
import { tracer } from "./trace";

const SYSTEM_PROMPT =
  "You audit carrier invoices. Given an invoice, its load, the rate confirmation " +
  "and the proof of delivery,\n" +
  'reply with one JSON object: {"action": "pay" or "dispute", "amount_usd": number, ' +
  '"reason_code": string or null, "note": string}.';

type Span = ReturnType<typeof tracer>;
type CallTool = (name: string, args: Record<string, unknown>) => Promise<ToolAnswer>;

export async function runJob(job: Job) {
  const span = tracer(job.run_id);
  const jobAttributes = {
    "gen_ai.agent.name": "freight-audit-clerk",
    "x.job.id": job.job_id,
    "x.tenant": job.tenant,
    "x.trigger.kind": job.trigger.kind,
  };
  await span("invoke_agent", null, jobAttributes, async (rootId, addRootAttributes) => {
    const callTool = toolCaller(span, rootId, job);
    try {
      // 1. Read the evidence.
      const invoice = await callTool("read_invoice", { invoice_id: job.input.invoice_id });
      const load = await callTool("find_load", { load_id: invoice.load_id });
      const rate = await callTool("read_rate_confirmation", { load_id: invoice.load_id });
      const proofOfDelivery = await callTool("read_proof_of_delivery", {
        load_id: invoice.load_id,
      });

      // 2. Ask the model for a draft, if there is a key.
      const evidence = { invoice, load, rate, pod: proofOfDelivery };
      const draft = await askForDraft(span, rootId, evidence);

      // 3. TODO (pay-one-invoice): decide, call pay_invoice with an Idempotency-Key,
      //    read the ledger, then report done.
      const draftNote = draft ? `Draft: ${draft}` : "No model key, so no draft.";
      const reason = `Read the evidence for ${invoice.invoice_id}. ${draftNote} Paying comes next.`;
      jobs.set(job.job_id, { status: "stopped", reason });
      addRootAttributes({ "x.outcome": "stopped" });
    } catch (error) {
      jobs.set(job.job_id, { status: "failed", reason: (error as Error).message });
      addRootAttributes({ "x.outcome": "failed" });
    }
  });
}

// Every tool call gets its own span under the job's root span.
function toolCaller(span: Span, rootId: string, job: Job): CallTool {
  return (name, args) => {
    const toolAttributes = {
      "gen_ai.tool.name": name,
      "gen_ai.tool.call.id": crypto.randomUUID(),
      "x.side_effect": "none",
    };
    return span("execute_tool", rootId, toolAttributes, () => tool(name, args, job));
  };
}

// Without a model key there is no draft, and no chat span either.
async function askForDraft(span: Span, rootId: string, evidence: ToolAnswer) {
  if (!(await canAsk())) return null;
  return span("chat", rootId, {}, async (_spanId, addAttributes) => {
    const answer = await ask(SYSTEM_PROMPT, JSON.stringify(evidence));
    if (answer) {
      addAttributes({
        "gen_ai.request.model": answer.model,
        "gen_ai.usage.input_tokens": answer.input_tokens,
        "gen_ai.usage.output_tokens": answer.output_tokens,
      });
    }
    return answer?.text ?? null;
  });
}

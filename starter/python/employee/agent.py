# The job loop. Today it reads the evidence and asks the model for a draft.
# Paying is your next step.
import json
import uuid

from employee.jobs import jobs
from employee.model import ask, can_ask
from employee.tools import tool
from employee.trace import Tracer

SYSTEM_PROMPT = (
    "You audit carrier invoices. Given an invoice, its load, the rate confirmation "
    "and the proof of delivery,\n"
    'reply with one JSON object: {"action": "pay" or "dispute", "amount_usd": number, '
    '"reason_code": string or null, "note": string}.'
)


def run_job(job):
    tracer = Tracer(job["run_id"])
    job_attributes = {
        "gen_ai.agent.name": "freight-audit-clerk",
        "x.job.id": job["job_id"],
        "x.tenant": job["tenant"],
        "x.trigger.kind": job["trigger"].get("kind", "person"),
    }
    with tracer.span("invoke_agent", None, job_attributes) as (root_id, root_attributes):
        call_tool = tool_caller(tracer, root_id, job)
        try:
            # 1. Read the evidence.
            invoice = call_tool("read_invoice", {"invoice_id": job["input"]["invoice_id"]})
            load = call_tool("find_load", {"load_id": invoice["load_id"]})
            rate = call_tool("read_rate_confirmation", {"load_id": invoice["load_id"]})
            proof_of_delivery = call_tool("read_proof_of_delivery", {"load_id": invoice["load_id"]})

            # 2. Ask the model for a draft, if there is a key.
            evidence = {"invoice": invoice, "load": load, "rate": rate, "pod": proof_of_delivery}
            draft = ask_for_draft(tracer, root_id, evidence)

            # 3. TODO (pay-one-invoice): decide, call pay_invoice with an Idempotency-Key,
            #    read the ledger, then report done.
            draft_note = f"Draft: {draft}" if draft else "No model key, so no draft."
            reason = (
                f"Read the evidence for {invoice['invoice_id']}. {draft_note} Paying comes next."
            )
            jobs.set(job["job_id"], status="stopped", reason=reason)
            root_attributes["x.outcome"] = "stopped"
        except Exception as error:
            jobs.set(job["job_id"], status="failed", reason=str(error))
            root_attributes["x.outcome"] = "failed"


# Every tool call gets its own span under the job's root span.
def tool_caller(tracer, root_id, job):
    def call_tool(name, args):
        tool_attributes = {
            "gen_ai.tool.name": name,
            "gen_ai.tool.call.id": uuid.uuid4().hex,
            "x.side_effect": "none",
        }
        with tracer.span("execute_tool", root_id, tool_attributes):
            return tool(name, args, job)

    return call_tool


# Without a model key there is no draft, and no chat span either.
def ask_for_draft(tracer, root_id, evidence):
    if not can_ask():
        return None
    with tracer.span("chat", root_id, {}) as (_span_id, chat_attributes):
        answer = ask(SYSTEM_PROMPT, json.dumps(evidence))
        chat_attributes.update(
            {
                "gen_ai.request.model": answer["model"],
                "gen_ai.usage.input_tokens": answer["input_tokens"],
                "gen_ai.usage.output_tokens": answer["output_tokens"],
            }
        )
        return answer["text"]

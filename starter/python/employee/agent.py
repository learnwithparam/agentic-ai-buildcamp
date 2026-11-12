# The job loop. Today it reads the evidence and asks the model for a draft. Paying is your next step.
import json
import uuid

from employee.jobs import jobs
from employee.model import ask, can_ask
from employee.tools import tool
from employee.trace import Tracer

SYSTEM = """You audit carrier invoices. Given an invoice, its load, the rate confirmation and the proof of delivery,
reply with one JSON object: {"action": "pay" or "dispute", "amount_usd": number, "reason_code": string or null, "note": string}."""


def run_job(job):
    t = Tracer(job["run_id"])
    tenant, job_id = job["tenant"], job["job_id"]
    root_attrs = {"gen_ai.agent.name": "freight-audit-clerk", "x.job.id": job_id, "x.tenant": tenant, "x.trigger.kind": job["trigger"].get("kind", "person")}
    with t.span("invoke_agent", None, root_attrs) as (root, attrs):

        def call(name, args):
            with t.span("execute_tool", root, {"gen_ai.tool.name": name, "gen_ai.tool.call.id": uuid.uuid4().hex, "x.side_effect": "none"}):
                return tool(name, args, tenant, job_id)

        try:
            # 1. Read the evidence.
            invoice = call("read_invoice", {"invoice_id": job["input"]["invoice_id"]})
            load = call("find_load", {"load_id": invoice["load_id"]})
            rate = call("read_rate_confirmation", {"load_id": invoice["load_id"]})
            pod = call("read_proof_of_delivery", {"load_id": invoice["load_id"]})

            # 2. Ask the model for a draft, if there is a key.
            draft = None
            if can_ask():
                with t.span("chat", root, {}) as (_, chat_attrs):
                    r = ask(SYSTEM, json.dumps({"invoice": invoice, "load": load, "rate": rate, "pod": pod}))
                    chat_attrs.update({"gen_ai.request.model": r["model"], "gen_ai.usage.input_tokens": r["input_tokens"], "gen_ai.usage.output_tokens": r["output_tokens"]})
                    draft = r["text"]

            # 3. TODO (pay-one-invoice): decide, call pay_invoice with an Idempotency-Key, read the ledger, then report done.
            note = f"Draft: {draft}" if draft else "No model key, so no draft."
            jobs.set(job_id, status="stopped", reason=f"Read the evidence for {invoice['invoice_id']}. {note} Paying comes next.")
            attrs["x.outcome"] = "stopped"
        except Exception as e:
            jobs.set(job_id, status="failed", reason=str(e))
            attrs["x.outcome"] = "failed"

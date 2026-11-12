# The contract server: the six routes of contract version 1.
import threading
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from employee.agent import run_job
from employee.jobs import jobs

NAME = "freight-audit-clerk"
app = FastAPI()


class Trigger(BaseModel):
    kind: str = "person"
    by: str | None = None


class JobRequest(BaseModel):
    job_id: str
    tenant: str
    trigger: Trigger = Trigger()
    input: dict


@app.get("/health")
def health():
    return {"contract": "1", "employee": NAME, "tenants": ["kaas-freight"]}


@app.post("/jobs", status_code=202)
def start_job(body: JobRequest):
    if "invoice_id" not in body.input:
        return JSONResponse({"error": 'send {"input": {"invoice_id"}}'}, status_code=400)
    # The same job twice starts nothing new.
    seen = jobs.get(body.job_id)
    if seen:
        return JSONResponse({"job_id": seen["job_id"], "run_id": seen["run_id"]}, status_code=200)
    new_job = {
        "job_id": body.job_id,
        "run_id": f"run-{uuid.uuid4().hex[:8]}",
        "tenant": body.tenant,
        "trigger": body.trigger.model_dump(),
        "input": body.input,
    }
    job = jobs.add(new_job)
    threading.Thread(target=run_job, args=(job,), daemon=True).start()
    return {"job_id": job["job_id"], "run_id": job["run_id"]}


@app.get("/jobs/{job_id}")
def read_job(job_id: str):
    job = jobs.get(job_id)
    if not job:
        return JSONResponse({"error": "no such job"}, status_code=404)
    return {"status": job["status"], "reason": job["reason"], "cost_usd": job["cost_usd"]}


# Approvals arrive in the Build part (ask-for-approval).
# Until then there are none to list or decide.
@app.get("/approvals")
def list_approvals(status: str = "waiting"):
    return []


@app.post("/approvals/{approval_id}")
async def decide(approval_id: str, request: Request):
    return JSONResponse({"error": "no such approval"}, status_code=404)


@app.get("/board")
def board():
    all_jobs = jobs.all()
    outcomes = sum(1 for job in all_jobs if job["status"] == "done")
    spend = sum(job["cost_usd"] for job in all_jobs)
    cost_per_outcome = spend / outcomes if outcomes else None
    row = {"outcomes": outcomes, "spend_usd": spend, "cost_per_outcome_usd": cost_per_outcome}
    by_employee = [{"employee": NAME, **row}]
    return {"tenants": [{"tenant": "kaas-freight", **row, "by_employee": by_employee}]}

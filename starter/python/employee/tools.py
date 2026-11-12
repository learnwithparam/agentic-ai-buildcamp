# Call the world's tools over HTTP. Every call names the job's tenant.
# Writes need an Idempotency-Key.
import os

import httpx

WORLD = os.environ.get("WORLD_URL", "http://localhost:7700")


def tool(name, args, job, idempotency_key=None):
    headers = {
        "x-tenant": job["tenant"],
        "x-job-id": job["job_id"],
        "x-employee": "freight-audit-clerk",
    }
    if idempotency_key:
        headers["idempotency-key"] = idempotency_key
    response = httpx.post(f"{WORLD}/tools/{name}", json=args, headers=headers, timeout=30)
    if response.status_code >= 400:
        error = response.json().get("error", "")
        raise RuntimeError(f"{name} failed: HTTP {response.status_code} {error}")
    return response.json()

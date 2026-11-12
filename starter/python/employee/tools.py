# Call the world's tools over HTTP. Every call names the job's tenant. Writes need an Idempotency-Key.
import os

import httpx

WORLD = os.environ.get("WORLD_URL", "http://localhost:7700")


def tool(name, args, tenant, job_id, key=None):
    headers = {"x-tenant": tenant, "x-job-id": job_id, "x-employee": "freight-audit-clerk"}
    if key:
        headers["idempotency-key"] = key
    r = httpx.post(f"{WORLD}/tools/{name}", json=args, headers=headers, timeout=30)
    if r.status_code >= 400:
        raise RuntimeError(f"{name} failed: HTTP {r.status_code} {r.json().get('error', '')}")
    return r.json()

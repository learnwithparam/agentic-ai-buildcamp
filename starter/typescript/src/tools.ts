// Call the world's tools over HTTP. Every call names the job's tenant. Writes need an Idempotency-Key.
const WORLD = process.env.WORLD_URL ?? "http://localhost:7700";

export async function tool(
  name: string,
  args: Record<string, unknown>,
  ctx: { tenant: string; job_id: string; key?: string },
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tenant": ctx.tenant,
    "x-job-id": ctx.job_id,
    "x-employee": "freight-audit-clerk",
  };
  if (ctx.key) headers["idempotency-key"] = ctx.key;
  const res = await fetch(`${WORLD}/tools/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${name} failed: HTTP ${res.status} ${body.error ?? ""}`);
  return body;
}

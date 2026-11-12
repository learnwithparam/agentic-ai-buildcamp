// Call the world's tools over HTTP. Every call names the job's tenant.
// Writes need an Idempotency-Key.
import type { Job } from "./jobs";

const WORLD = process.env.WORLD_URL ?? "http://localhost:7700";

// A tool answers with a JSON object. Read the fields you need from it.
export type ToolAnswer = Record<string, unknown>;

export async function tool(
  name: string,
  args: Record<string, unknown>,
  job: Pick<Job, "tenant" | "job_id">,
  idempotencyKey?: string,
): Promise<ToolAnswer> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tenant": job.tenant,
    "x-job-id": job.job_id,
    "x-employee": "freight-audit-clerk",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  const response = await fetch(`${WORLD}/tools/${name}`, {
    method: "POST",
    headers,
    body: JSON.stringify(args),
  });
  const answer = (await response.json().catch(() => ({}))) as ToolAnswer;
  if (!response.ok) {
    throw new Error(`${name} failed: HTTP ${response.status} ${answer.error ?? ""}`);
  }
  return answer;
}

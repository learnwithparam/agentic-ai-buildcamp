// A small client for the world's HTTP tools. Every call names the tenant, the employee and the job.
export class ToolFailed extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export type CallInfo = { tenant: string; job_id: string; employee: string; key?: string };

export function worldClient(base = process.env.WORLD_URL ?? "http://localhost:7700") {
  async function call(tool: string, args: Record<string, unknown>, info: CallInfo): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json", "x-tenant": info.tenant, "x-employee": info.employee, "x-job-id": info.job_id };
    if (info.key) headers["idempotency-key"] = info.key;
    let res: Response;
    try {
      res = await fetch(`${base}/tools/${tool}`, { method: "POST", headers, body: JSON.stringify(args), signal: AbortSignal.timeout(30_000) });
    } catch (e) {
      throw new ToolFailed(0, `could not reach the world at ${base}: ${(e as Error).message}`);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new ToolFailed(res.status, body.error ?? `HTTP ${res.status}`);
    return body;
  }
  const people = async () => (await fetch(`${base}/people`)).json() as Promise<any[]>;
  return { base, call, people };
}

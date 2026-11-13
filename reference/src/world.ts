// A small client for the world's HTTP tools. Every call names the tenant, the employee and the job.
export class ToolFailed extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export type CallInfo = { tenant: string; job_id: string; employee: string; key?: string };

// A person who works for a tenant, as GET /people lists them.
export type Person = {
  person_id: string;
  name: string;
  tenant: string;
  role: string;
  may_approve: boolean;
  pay_limit_usd: number | null;
  dispute_limit_usd: number | null;
};

function headersFor(info: CallInfo): Record<string, string> {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    "x-tenant": info.tenant,
    "x-employee": info.employee,
    "x-job-id": info.job_id,
  };
  if (info.key) headers["idempotency-key"] = info.key;
  return headers;
}

export function worldClient(base = process.env.WORLD_URL ?? "http://localhost:7700") {
  async function send(tool: string, args: Record<string, unknown>, info: CallInfo) {
    try {
      return await fetch(`${base}/tools/${tool}`, {
        method: "POST",
        headers: headersFor(info),
        body: JSON.stringify(args),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (error) {
      throw new ToolFailed(0, `could not reach the world at ${base}: ${(error as Error).message}`);
    }
  }

  // The caller names the shape of the reply it expects: call<Invoice>("read_invoice", ...).
  async function call<Reply>(
    tool: string,
    args: Record<string, unknown>,
    info: CallInfo,
  ): Promise<Reply> {
    const response = await send(tool, args, info);
    const body = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) {
      throw new ToolFailed(response.status, body.error ?? `HTTP ${response.status}`);
    }
    return body as Reply;
  }

  async function people(): Promise<Person[]> {
    const response = await fetch(`${base}/people`);
    return response.json() as Promise<Person[]>;
  }

  return { base, call, people };
}

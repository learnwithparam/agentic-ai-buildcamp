// Talk to a running employee through contract version 1, over HTTP or as CLI commands.
import { spawnSync } from "node:child_process";
import type { Running } from "./employee";
import { CheckProblem } from "./employee";

export type JobState = {
  status: string;
  reason?: string | null;
  cost_usd?: number;
  run_id?: string;
};
// The body is whatever JSON the employee sent; each check reads only the fields it needs.
// biome-ignore lint/suspicious/noExplicitAny: checks outside checks/lib read fields from it freely.
export type Answer = { status: number; body: any };

type WaitOptions = { ms?: number; until?: (state: JobState) => boolean };

async function askOverHttp(
  employee: Running,
  method: string,
  path: string,
  body?: unknown,
): Promise<Answer> {
  try {
    const response = await fetch(employee.base + path, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
    const json = await response.json().catch(() => null);
    return { status: response.status, body: json };
  } catch (error) {
    throw new CheckProblem(`${method} ${path} got no answer: ${(error as Error).message}`);
  }
}

// A CLI employee prints its answer as the last line of its output.
function lastLineAsJson(output: string): unknown {
  const lastLine = output.trim().split("\n").pop() ?? "";
  try {
    return JSON.parse(lastLine);
  } catch {
    return null;
  }
}

function statusFrom(parsed: unknown): number {
  if (typeof parsed !== "object" || parsed === null || !("status" in parsed)) return 200;
  const status = parsed.status;
  if (status && typeof status === "number") return status;
  return 200;
}

function askOverCli(employee: Running, action: string, body: unknown): Answer {
  const start = employee.toml.contract.start;
  const result = spawnSync("sh", ["-c", `exec ${start} ${action}`], {
    cwd: employee.dir,
    env: employee.env,
    input: JSON.stringify(body ?? {}),
    timeout: 60_000,
  });
  const parsed = lastLineAsJson(result.stdout.toString());
  if (result.status !== 0 && !parsed) {
    const errorTail = result.stderr.toString().slice(-400);
    throw new CheckProblem(`"${start} ${action}" exited ${result.status}: ${errorTail}`);
  }
  return { status: statusFrom(parsed), body: parsed };
}

function jobFound(answer: Answer): boolean {
  return answer.status === 200 && Boolean(answer.body);
}

function jobStateFrom(answer: Answer): JobState {
  if (jobFound(answer)) return answer.body;
  return { status: `HTTP ${answer.status}` };
}

// Stop when the job's state satisfies `until`, or when the employee does not know the job.
function waitIsOver(answer: Answer, state: JobState, until: (state: JobState) => boolean) {
  if (jobFound(answer)) return until(state);
  return answer.status === 404;
}

export function contract(employee: Running) {
  const call = (method: string, path: string, action: string, body?: unknown) => {
    if (employee.mode === "cli") return Promise.resolve(askOverCli(employee, action, body));
    return askOverHttp(employee, method, path, method === "GET" ? undefined : body);
  };

  return {
    health: () => call("GET", "/health", "health", {}),
    startJob: (job: unknown) => call("POST", "/jobs", "start-job", job),
    readJob: (id: string) =>
      call("GET", `/jobs/${encodeURIComponent(id)}`, "read-job", { job_id: id }),
    approvals: (status = "waiting") =>
      call("GET", `/approvals?status=${status}`, "list-approvals", { status }),
    decide: (id: string, decision: "approve" | "decline", decidedBy: string) =>
      call("POST", `/approvals/${encodeURIComponent(id)}`, "decide", {
        approval_id: id,
        decision,
        by: decidedBy,
      }),
    board: () => call("GET", "/board", "board", {}),
    // Wait until the job leaves `working`, or until `until` says stop. Returns the last state seen.
    async waitJob(id: string, options: WaitOptions = {}): Promise<JobState> {
      const until = options.until ?? ((state) => state.status !== "working");
      const deadline = Date.now() + (options.ms ?? 20_000);
      let last: JobState = { status: "unknown" };
      while (Date.now() < deadline) {
        const answer = await this.readJob(id);
        last = jobStateFrom(answer);
        if (waitIsOver(answer, last, until)) return last;
        await Bun.sleep(100);
      }
      return last;
    },
  };
}
export type Contract = ReturnType<typeof contract>;

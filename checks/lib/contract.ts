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
export type Answer = { status: number; body: any };

export function contract(e: Running) {
  async function http(method: string, path: string, body?: unknown): Promise<Answer> {
    try {
      const res = await fetch(e.base + path, {
        method,
        headers: { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    } catch (err) {
      throw new CheckProblem(`${method} ${path} got no answer: ${(err as Error).message}`);
    }
  }
  function cli(action: string, body: unknown): Answer {
    const r = spawnSync("sh", ["-c", `exec ${e.toml.contract.start} ${action}`], {
      cwd: e.dir,
      env: e.env,
      input: JSON.stringify(body ?? {}),
      timeout: 60_000,
    });
    let parsed: any = null;
    try {
      parsed = JSON.parse(r.stdout.toString().trim().split("\n").pop() ?? "");
    } catch {}
    if (r.status !== 0 && !parsed)
      throw new CheckProblem(
        `"${e.toml.contract.start} ${action}" exited ${r.status}: ${r.stderr.toString().slice(-400)}`,
      );
    return {
      status: parsed?.status && typeof parsed.status === "number" ? parsed.status : 200,
      body: parsed,
    };
  }
  const call = (method: string, path: string, action: string, body?: unknown) =>
    e.mode === "cli"
      ? Promise.resolve(cli(action, body))
      : http(method, path, method === "GET" ? undefined : body);

  return {
    health: () => call("GET", "/health", "health", {}),
    startJob: (job: unknown) => call("POST", "/jobs", "start-job", job),
    readJob: (id: string) =>
      call("GET", `/jobs/${encodeURIComponent(id)}`, "read-job", { job_id: id }),
    approvals: (status = "waiting") =>
      call("GET", `/approvals?status=${status}`, "list-approvals", { status }),
    decide: (id: string, decision: "approve" | "decline", by: string) =>
      call("POST", `/approvals/${encodeURIComponent(id)}`, "decide", {
        approval_id: id,
        decision,
        by,
      }),
    board: () => call("GET", "/board", "board", {}),
    // Wait until the job leaves `working`, or until `until` says stop. Returns the last state seen.
    async waitJob(
      id: string,
      opts: { ms?: number; until?: (s: JobState) => boolean } = {},
    ): Promise<JobState> {
      const until = opts.until ?? ((s) => s.status !== "working");
      const limit = Date.now() + (opts.ms ?? 20_000);
      let last: JobState = { status: "unknown" };
      while (Date.now() < limit) {
        const a = await this.readJob(id);
        if (a.status === 200 && a.body) {
          last = a.body;
          if (until(last)) return last;
        } else {
          last = { status: `HTTP ${a.status}` };
          if (a.status === 404) return last;
        }
        await Bun.sleep(100);
      }
      return last;
    },
  };
}
export type Contract = ReturnType<typeof contract>;

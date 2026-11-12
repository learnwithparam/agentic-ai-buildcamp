// Start a learner's employee from its employee.toml, wait for health, kill it, restart it, stop it.
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..", "..");

export type EmployeeToml = {
  hire?: Record<string, unknown>;
  contract: { version: string; mode?: "http" | "cli"; start: string; url?: string; traces?: string };
  budget?: Record<string, number>;
};

export class CheckProblem extends Error {}

// Where the employee is: the folder the check points at, else EMPLOYEE_DIR, else employee/ at the repo root.
export function findEmployeeDir(dir: string): string {
  for (const d of [dir, process.env.EMPLOYEE_DIR, join(ROOT, "employee")])
    if (d && existsSync(join(d, "employee.toml"))) return resolve(d);
  throw new CheckProblem(`No employee.toml in ${dir}. Copy a starter kit (starter/typescript or starter/python) and keep employee.toml next to it.`);
}

export function readEmployeeToml(dir: string): EmployeeToml {
  const path = join(dir, "employee.toml");
  let t: any;
  try { t = Bun.TOML.parse(readFileSync(path, "utf8")); } catch (e) {
    throw new CheckProblem(`employee.toml does not parse: ${(e as Error).message}`);
  }
  if (!t.contract?.start) throw new CheckProblem("employee.toml needs [contract] with start = the command that starts your employee.");
  return t as EmployeeToml;
}

export async function freePort(): Promise<number> {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const p = s.port;
  s.stop(true);
  return p!;
}

export type Running = {
  dir: string;
  toml: EmployeeToml;
  mode: "http" | "cli";
  base: string;
  traceDir: string;
  stateDir: string;
  env: Record<string, string>;
  output: () => string;
  kill: () => Promise<void>;     // SIGKILL, no warning, like a crash
  stop: () => Promise<void>;     // SIGTERM, then SIGKILL after 2 s
  restart: () => Promise<void>;  // start again with the same state and trace folders
};

const tmp = (p: string) => mkdtempSync(join(tmpdir(), `buildcamp-${p}-`));

export async function startEmployee(dir: string, worldUrl: string, opts: { healthMs?: number; env?: Record<string, string> } = {}): Promise<Running> {
  const toml = readEmployeeToml(dir);
  const mode = toml.contract.mode ?? "http";
  const port = await freePort();
  const traceDir = tmp("traces"), stateDir = tmp("state");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), PORT: String(port), WORLD_URL: worldUrl, TRACE_DIR: traceDir,
    STATE_DIR: stateDir, MODEL_MODE: process.env.CHECK_MODEL_MODE ?? "replay", ...opts.env };
  delete env.BOARD_PORT;
  let child: ChildProcess | null = null;
  let out = "";
  const r: Running = {
    dir, toml, mode, base: `http://localhost:${port}`, traceDir, stateDir, env,
    output: () => out.slice(-2000),
    async kill() { if (child?.pid) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited(child, 3000); child = null; } },
    async stop() {
      if (!child?.pid) return;
      try { process.kill(-child.pid, "SIGTERM"); } catch {}
      if (!(await exited(child, 2000))) { try { process.kill(-child.pid, "SIGKILL"); } catch {} await exited(child, 2000); }
      child = null;
    },
    async restart() { await launch(); },
  };
  async function launch() {
    if (mode === "cli") return; // a CLI employee is a new process for every command
    child = spawn("sh", ["-c", `exec ${toml.contract.start}`], { cwd: dir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    const limit = Date.now() + (opts.healthMs ?? 10_000);
    while (Date.now() < limit) {
      if (child.exitCode !== null) throw new CheckProblem(`Your employee exited before it answered GET /health (exit ${child.exitCode}). Its last output:\n${out.slice(-800)}`);
      const ok = await fetch(`${r.base}/health`, { signal: AbortSignal.timeout(500) }).then((x) => x.ok).catch(() => false);
      if (ok) return;
      await Bun.sleep(100);
    }
    await r.kill();
    throw new CheckProblem(`Your employee did not answer GET /health within ${(opts.healthMs ?? 10_000) / 1000} s on the port in PORT (${port}). Read PORT from the environment and listen on it.`);
  }
  await launch();
  return r;
}

function exited(c: ChildProcess, ms: number): Promise<boolean> {
  if (c.exitCode !== null || c.signalCode !== null) return Promise.resolve(true);
  return new Promise((res) => {
    const t = setTimeout(() => res(false), ms);
    c.once("exit", () => { clearTimeout(t); res(true); });
  });
}

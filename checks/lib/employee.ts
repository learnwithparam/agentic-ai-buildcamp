// Start a learner's employee from its employee.toml, wait for health, kill it, restart it, stop it.
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..", "..");

export type EmployeeToml = {
  hire?: Record<string, unknown>;
  contract: {
    version: string;
    mode?: "http" | "cli";
    start: string;
    url?: string;
    traces?: string;
  };
  budget?: Record<string, number>;
};

export class CheckProblem extends Error {}

// Where the employee is: the folder the check points at, else EMPLOYEE_DIR, else employee/ at the
// repo root.
export function findEmployeeDir(dir: string): string {
  for (const candidate of [dir, process.env.EMPLOYEE_DIR, join(ROOT, "employee")]) {
    if (candidate && existsSync(join(candidate, "employee.toml"))) return resolve(candidate);
  }
  throw new CheckProblem(
    `No employee.toml in ${dir}. ` +
      "Copy a starter kit (starter/typescript or starter/python) " +
      "and keep employee.toml next to it.",
  );
}

export function readEmployeeToml(dir: string): EmployeeToml {
  const path = join(dir, "employee.toml");
  let toml: Partial<EmployeeToml>;
  try {
    toml = Bun.TOML.parse(readFileSync(path, "utf8")) as Partial<EmployeeToml>;
  } catch (error) {
    throw new CheckProblem(`employee.toml does not parse: ${(error as Error).message}`);
  }
  if (!toml.contract?.start) {
    throw new CheckProblem(
      "employee.toml needs [contract] with start = the command that starts your employee.",
    );
  }
  return toml as EmployeeToml;
}

export async function freePort(): Promise<number> {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port;
  server.stop(true);
  if (port === undefined) throw new CheckProblem("Could not find a free port for the employee.");
  return port;
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
  kill: () => Promise<void>; // SIGKILL, no warning, like a crash
  stop: () => Promise<void>; // SIGTERM, then SIGKILL after 2 s
  restart: () => Promise<void>; // start again with the same state and trace folders
};

type StartOptions = { healthMs?: number; env?: Record<string, string> };

// The employee's process while it runs, and everything it has printed so far.
type EmployeeProcess = { child: ChildProcess | null; printed: string };

type LaunchSettings = {
  dir: string;
  command: string;
  env: Record<string, string>;
  base: string;
  healthMs: number;
};

function newTempFolder(purpose: string): string {
  return mkdtempSync(join(tmpdir(), `buildcamp-${purpose}-`));
}

type EmployeePaths = { port: number; worldUrl: string; traceDir: string; stateDir: string };

function employeeEnv(paths: EmployeePaths, extraEnv: Record<string, string> = {}) {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  env.PORT = String(paths.port);
  env.WORLD_URL = paths.worldUrl;
  env.TRACE_DIR = paths.traceDir;
  env.STATE_DIR = paths.stateDir;
  env.MODEL_MODE = process.env.CHECK_MODEL_MODE ?? "replay";
  Object.assign(env, extraEnv);
  delete env.BOARD_PORT;
  return env;
}

// The employee runs in its own process group, so one signal reaches it and anything it started.
function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The group has already gone.
  }
}

async function killProcess(running: EmployeeProcess) {
  const child = running.child;
  if (!child?.pid) return;
  signalGroup(child, "SIGKILL");
  await exited(child, 3000);
  running.child = null;
}

async function stopProcess(running: EmployeeProcess) {
  const child = running.child;
  if (!child?.pid) return;
  signalGroup(child, "SIGTERM");
  if (!(await exited(child, 2000))) {
    signalGroup(child, "SIGKILL");
    await exited(child, 2000);
  }
  running.child = null;
}

async function answersHealth(base: string): Promise<boolean> {
  try {
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(500) });
    return response.ok;
  } catch {
    return false;
  }
}

// Polls GET /health until it answers, and fails at once if the process exits first.
async function waitForHealth(
  running: EmployeeProcess,
  child: ChildProcess,
  settings: LaunchSettings,
) {
  const deadline = Date.now() + settings.healthMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new CheckProblem(
        `Your employee exited before it answered GET /health (exit ${child.exitCode}). ` +
          `Its last output:\n${running.printed.slice(-800)}`,
      );
    }
    if (await answersHealth(settings.base)) return true;
    await Bun.sleep(100);
  }
  return false;
}

async function launchProcess(running: EmployeeProcess, settings: LaunchSettings) {
  const child = spawn("sh", ["-c", `exec ${settings.command}`], {
    cwd: settings.dir,
    env: settings.env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  running.child = child;
  child.stdout?.on("data", (chunk) => {
    running.printed += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    running.printed += chunk;
  });
  return waitForHealth(running, child, settings);
}

export async function startEmployee(
  dir: string,
  worldUrl: string,
  options: StartOptions = {},
): Promise<Running> {
  const toml = readEmployeeToml(dir);
  const mode = toml.contract.mode ?? "http";
  const port = await freePort();
  const traceDir = newTempFolder("traces");
  const stateDir = newTempFolder("state");
  const env = employeeEnv({ port, worldUrl, traceDir, stateDir }, options.env);
  const healthMs = options.healthMs ?? 10_000;
  const base = `http://localhost:${port}`;
  const employeeProcess: EmployeeProcess = { child: null, printed: "" };
  const settings: LaunchSettings = { dir, command: toml.contract.start, env, base, healthMs };

  async function launch() {
    if (mode === "cli") return; // a CLI employee is a new process for every command
    if (await launchProcess(employeeProcess, settings)) return;
    await killProcess(employeeProcess);
    throw new CheckProblem(
      `Your employee did not answer GET /health within ${healthMs / 1000} s ` +
        `on the port in PORT (${port}). Read PORT from the environment and listen on it.`,
    );
  }

  await launch();
  return {
    dir,
    toml,
    mode,
    base,
    traceDir,
    stateDir,
    env,
    output: () => employeeProcess.printed.slice(-2000),
    kill: () => killProcess(employeeProcess),
    stop: () => stopProcess(employeeProcess),
    restart: launch,
  };
}

function exited(child: ChildProcess, waitMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolveExit) => {
    const timer = setTimeout(() => resolveExit(false), waitMs);
    child.once("exit", () => {
      clearTimeout(timer);
      resolveExit(true);
    });
  });
}

// The closing part's check. It runs the learner's graph as a program, kills it at the pause,
// restarts it, and reads Postgres. It never imports the learner's code.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "../../scripts/structure";

export const ASSIGNMENT_DIR = join(ROOT, "assignment");
const COMPOSE = ["compose", "-f", join(ASSIGNMENT_DIR, "compose.yml")];
const DATABASE_URL = "postgres://postgres@localhost:54329/assignment";
const PINS = { typescript: "1.7.4", python: "1.2.21" };
const WAIT_MS = 150_000;

export type Language = "typescript" | "python";
export type Line = { says: string; result: "pass" | "fail" | "skipped" };

export const LINE_SAYS = [
  "the LangGraph package in the lockfile is the pinned version",
  "a run above the limit stops at an interrupt and writes a checkpoint row",
  "after a kill and a restart, the run resumes on the same thread_id",
  "the ledger has exactly one payment row for that run",
  "a run below the limit finishes with no interrupt",
];

const docker = (args: string[]) => spawnSync("docker", args, { encoding: "utf8" });

// Start Postgres once per process. Remove it again at exit, but only if this check started it.
let database: Promise<boolean> | undefined;
function ensureDatabase(): Promise<boolean> {
  database ??= (async () => {
    if (!Bun.which("docker") || docker(["info"]).status !== 0) return false;
    const alreadyRunning = docker([...COMPOSE, "ps", "-q"]).stdout.trim() !== "";
    const started = docker([...COMPOSE, "up", "-d", "--wait"]);
    if (!alreadyRunning) {
      process.on("exit", () => {
        docker([...COMPOSE, "down", "-v"]);
      });
    }
    return started.status === 0;
  })();
  return database;
}

function sql(query: string): string {
  const flags = ["exec", "-T", "db", "psql", "-U", "postgres", "-d", "assignment", "-tAc", query];
  return docker([...COMPOSE, ...flags]).stdout.trim();
}

function commandFor(language: Language, dir: string, args: string[]): string[] {
  if (language === "typescript") return ["bun", join(dir, "graph.ts"), ...args];
  return ["uv", "run", "--project", ASSIGNMENT_DIR, "python", join(dir, "graph.py"), ...args];
}

function launch(language: Language, dir: string, args: string[]) {
  // Keep uv's virtual environment out of the repo, so the standard check never walks into it.
  const venv = join(tmpdir(), "buildcamp-assignment-venv");
  const names = Object.fromEntries([
    ["DATABASE_URL", DATABASE_URL],
    ["UV_PROJECT_ENVIRONMENT", process.env.UV_PROJECT_ENVIRONMENT ?? venv],
  ]);
  const environment = { ...process.env, ...names };
  const stdio = { stdout: "pipe", stderr: "pipe", env: environment, cwd: ROOT } as const;
  return Bun.spawn(commandFor(language, dir, args), stdio);
}

type Launched = ReturnType<typeof launch>;

// Read the program's output until it prints `needle`, exits, or time runs out.
async function outputUntil(program: Launched, needle: string | null): Promise<string> {
  let text = "";
  const reader = program.stdout.getReader();
  const timer = setTimeout(() => program.kill("SIGKILL"), WAIT_MS);
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
    if (needle && text.includes(needle)) break;
  }
  clearTimeout(timer);
  reader.releaseLock();
  return text;
}

function lockfilePinned(language: Language): boolean {
  if (language === "typescript") {
    const lock = readFileSync(join(ROOT, "bun.lock"), "utf8");
    return lock.includes(`"@langchain/langgraph@${PINS.typescript}"`);
  }
  const lockPath = join(ASSIGNMENT_DIR, "uv.lock");
  if (!existsSync(lockPath)) return false;
  const lock = readFileSync(lockPath, "utf8");
  return lock.includes(`name = "langgraph"\nversion = "${PINS.python}"`);
}

async function runLanguage(language: Language, dir: string): Promise<Line[]> {
  const suffix = Math.random().toString(36).slice(2, 8);
  const high = `high-${suffix}`;
  const low = `low-${suffix}`;
  const pinned = lockfilePinned(language);

  const first = launch(language, dir, ["start", high, "7850"]);
  const firstOutput = await outputUntil(first, "PAUSED");
  const paused = firstOutput.includes("PAUSED");
  first.kill("SIGKILL");
  await first.exited;
  const checkpoints = Number(sql(`select count(*) from checkpoints where thread_id = '${high}'`));

  const second = launch(language, dir, ["resume", high]);
  const secondOutput = await outputUntil(second, null);
  await second.exited;
  const resumed = secondOutput.includes("DONE paid") && !secondOutput.includes("node decide");
  const rows = Number(sql(`select count(*) from payments where run_id = '${high}'`));

  const third = launch(language, dir, ["start", low, "1200"]);
  const thirdOutput = await outputUntil(third, null);
  await third.exited;
  const finished = thirdOutput.includes("DONE paid") && !thirdOutput.includes("PAUSED");

  const answers = [pinned, paused && checkpoints > 0, resumed, rows === 1, finished];
  return LINE_SAYS.map((says, index) => ({ says, result: answers[index] ? "pass" : "fail" }));
}

const cache = new Map<string, Promise<Record<string, Line[]>>>();

// The graph files in `dir`. A folder with none is the learner's own work, in assignment/.
export function workFolder(dir: string): string {
  const has = (file: string) => existsSync(join(dir, file));
  return has("graph.ts") || has("graph.py") ? dir : ASSIGNMENT_DIR;
}

function languagesIn(folder: string): Language[] {
  const languages: Language[] = [];
  if (existsSync(join(folder, "graph.ts"))) languages.push("typescript");
  if (existsSync(join(folder, "graph.py"))) languages.push("python");
  return languages;
}

async function evaluateFolder(folder: string): Promise<Record<string, Line[]>> {
  const found: Record<string, Line[]> = {};
  const skipped = LINE_SAYS.map((says) => ({ says, result: "skipped" as const }));
  const ready = await ensureDatabase();
  for (const language of languagesIn(folder)) {
    const canRun = ready && (language === "typescript" || Boolean(Bun.which("uv")));
    found[language] = canRun ? await runLanguage(language, folder) : skipped;
  }
  return found;
}

// One line list per language found in the folder. All five lines run once per folder.
export function evaluate(dir: string): Promise<Record<string, Line[]>> {
  const folder = workFolder(dir);
  const known = cache.get(folder);
  if (known) return known;
  const started = evaluateFolder(folder);
  cache.set(folder, started);
  return started;
}

export function writeResult(found: Record<string, Line[]>) {
  const tool = { "@langchain/langgraph": PINS.typescript, langgraph: PINS.python };
  const body = { version: 1, tool, languages: found };
  writeFileSync(join(ASSIGNMENT_DIR, "result.json"), `${JSON.stringify(body, null, 2)}\n`);
}

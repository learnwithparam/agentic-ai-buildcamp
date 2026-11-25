// npm run doctor: what is wrong with this machine, in one run. It only looks: it starts nothing,
// changes nothing and never prints a key. Every check runs, so one run names every problem.
// Each failure names its fix and the row in docs/learner/troubleshooting.md that explains it.
// npm run setup fixes most of them; the doctor is for when something broke halfway through a lesson.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statfsSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { checkNode, missingKeys } from "./setup";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
export const GUIDE = "docs/learner/troubleshooting.md";
export const MIN_DOCKER_GB = 6;
export const MIN_FREE_DISK_GB = 10;

// The keys the finished app reads. setup makes all but the first three; those you paste in.
export const REQUIRED_KEYS = [
  "OPENAI_API_KEY",
  "GATEWAY_KEY_MEDINFO_APP",
  "GATEWAY_KEY_EVAL_RUNNER",
  "LANGFUSE_PUBLIC_KEY",
  "LANGFUSE_SECRET_KEY",
  "DATABASE_URL",
  "OIDC_CLIENT_SECRET",
  "FGA_API_TOKEN",
  "FGA_STORE_ID",
  "FGA_MODEL_ID",
  "SEED_USER_PASSWORD"
];

// The port each service publishes on 127.0.0.1, written as stack/service.
export const PORTS: Array<[port: number, owner: string, service: string]> = [
  [5174, "Langfuse", "langfuse/langfuse-web"],
  [5442, "Postgres for the app", "infra/postgres"],
  [8180, "Keycloak", "infra/keycloak"],
  [8280, "OpenFGA", "infra/openfga"],
  [5001, "Docling", "infra/docling"]
];

// The services each compose file must keep running. openfga-migrate runs once and exits, so it is left out.
export const SERVICES = {
  langfuse: ["langfuse-web", "langfuse-worker", "langfuse-ai-gateway", "postgres", "clickhouse", "redis", "minio"],
  infra: ["postgres", "keycloak", "openfga", "docling"]
};

// Every check, in the order it runs. docs/learner/troubleshooting.md has one section per id
// (doctor.test.ts checks), and each failure points at it.
export const CHECK_IDS = ["node", "docker", "compose", "disk", "env", "langfuse-stack", "infra-stack", "ports", "services", "model", "app"] as const;
export type CheckId = (typeof CHECK_IDS)[number];
export type Result = { id: CheckId; ok: boolean; line: string; fix?: string };
export type ServiceState = { Service: string; State: string; Health?: string };

const pass = (id: CheckId, line: string): Result => ({ id, ok: true, line });
const fail = (id: CheckId, line: string, fix: string): Result => ({ id, ok: false, line, fix });

// `docker compose ps --format json` prints one JSON object per line (Compose 2.21 and later)
// or one JSON array (older 2.x). Both shapes come back as a list.
export function parseComposePs(output: string): ServiceState[] {
  const text = output.trim();
  if (!text) return [];
  if (text.startsWith("[")) return JSON.parse(text) as ServiceState[];
  return text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as ServiceState);
}

// The services that should run but are missing, stopped or unhealthy, with the state Docker gives.
export function unhealthy(states: ServiceState[], wanted: string[]): string[] {
  return wanted.flatMap((name) => {
    const state = states.find((s) => s.Service === name);
    if (!state) return [`${name} (not started)`];
    if (state.State !== "running") return [`${name} (${state.State})`];
    if (state.Health && state.Health !== "healthy") return [`${name} (${state.Health})`];
    return [];
  });
}

export function composeMajor(version: string): number {
  return Number(version.trim().replace(/^v/, "").split(".")[0]);
}

function docker(args: string[]): string {
  return execFileSync("docker", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function checkNodeVersion(): Result {
  const problem = checkNode(process.version);
  return problem ? fail("node", problem, "Install Node 22.18 or newer, then run npm ci.") : pass("node", `Node ${process.version}`);
}

function checkDocker(): Result {
  let bytes: number;
  try {
    bytes = Number(docker(["info", "--format", "{{.MemTotal}}"]).trim());
  } catch {
    return fail("docker", "Docker is not running", "Start Docker Desktop (or the Docker service) and wait until it says it is running.");
  }
  const gb = bytes / 1024 ** 3;
  if (gb < MIN_DOCKER_GB - 0.5) {
    return fail("docker", `Docker has ${gb.toFixed(1)} GB of memory`, `Give Docker at least ${MIN_DOCKER_GB} GB in its settings, under Resources.`);
  }
  return pass("docker", `Docker runs with ${gb.toFixed(1)} GB of memory`);
}

function checkCompose(): Result {
  let version: string;
  try {
    version = docker(["compose", "version", "--short"]);
  } catch {
    return fail("compose", "docker compose is missing", "Install Docker Compose v2. Docker Desktop has it; on Linux, install the docker-compose-plugin package.");
  }
  if (composeMajor(version) < 2) return fail("compose", `docker compose ${version.trim()} is too old`, "Update to Docker Compose v2.");
  return pass("compose", `docker compose ${version.trim()}`);
}

function checkDisk(): Result {
  const stats = statfsSync(root);
  const gb = (stats.bavail * stats.bsize) / 1024 ** 3;
  if (gb < MIN_FREE_DISK_GB) {
    return fail("disk", `${gb.toFixed(1)} GB free on this disk`, `Free at least ${MIN_FREE_DISK_GB} GB. docker system prune removes images you no longer use.`);
  }
  return pass("disk", `${gb.toFixed(0)} GB free on this disk`);
}

function readEnv(): Record<string, string | undefined> | null {
  return existsSync(envFile) ? parseEnv(readFileSync(envFile, "utf8")) : null;
}

function checkEnv(values: Record<string, string | undefined> | null): Result {
  if (!values) return fail("env", ".env is missing", "Run npm run setup. It makes .env from .env.example.");
  const missing = missingKeys(values, REQUIRED_KEYS);
  if (missing.length === 0) return pass("env", `.env has all ${REQUIRED_KEYS.length} keys the app reads`);
  const pasted = missing.filter((name) => REQUIRED_KEYS.indexOf(name) < 3);
  const fix = pasted.length
    ? `Paste ${pasted.join(" and ")} into .env (the troubleshooting page says where each comes from), then run npm run setup.`
    : "Run npm run setup. It fills these in.";
  return fail("env", `.env has no value for ${missing.join(", ")}`, fix);
}

function checkStack(name: keyof typeof SERVICES, args: string[]): Result & { down: string[] } {
  const id = name === "langfuse" ? "langfuse-stack" : "infra-stack";
  let states: ServiceState[];
  try {
    states = parseComposePs(docker([...args, "ps", "--all", "--format", "json"]));
  } catch {
    return { ...fail(id, `could not read the ${name} containers`, "Start Docker first, then run this again."), down: SERVICES[name].map((s) => `${name}/${s}`) };
  }
  const bad = unhealthy(states, SERVICES[name]);
  const down = bad.map((entry) => `${name}/${entry.split(" ")[0]}`);
  if (bad.length === 0) return { ...pass(id, `${name} containers run and are healthy`), down };
  const logs = `docker ${args.join(" ").replace(envFile, ".env")} logs ${bad[0].split(" ")[0]}`;
  return { ...fail(id, `${name} containers not ready: ${bad.join(", ")}`, `Run npm run setup to start them. If one keeps stopping, read its log: ${logs}`), down };
}

// A port held by another program stops a container from starting. A running service holds its own
// port, so only the ports of services that are down are tried.
function portFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}

export function portsToTry(down: string[]): Array<[number, string]> {
  return PORTS.filter(([, , service]) => down.includes(service)).map(([port, owner]) => [port, owner]);
}

async function checkPorts(down: string[]): Promise<Result> {
  const taken: string[] = [];
  for (const [port, owner] of portsToTry(down)) if (!(await portFree(port))) taken.push(`${port} (${owner})`);
  if (taken.length === 0) return pass("ports", "no other program holds a port the stack needs");
  return fail(
    "ports",
    `in use while the stack is down: ${taken.join(", ")}`,
    "Another program holds them. Find it with lsof -i :PORT (macOS, Linux) or netstat -ano (Windows), stop it, then run npm run setup."
  );
}

async function reachable(url: string): Promise<boolean> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return response.ok;
  } catch {
    return false;
  }
}

async function checkServices(values: Record<string, string | undefined>): Promise<Result> {
  const urls: Array<[string, string]> = [
    ["Langfuse", `${values.LANGFUSE_BASE_URL || "http://localhost:5174"}/api/public/health`],
    ["Keycloak", `${values.OIDC_ISSUER || "http://localhost:8180/realms/medinfo"}/.well-known/openid-configuration`],
    ["OpenFGA", `${values.FGA_API_URL || "http://localhost:8280"}/healthz`],
    ["Docling", "http://127.0.0.1:5001/health"]
  ];
  const down: string[] = [];
  for (const [name, url] of urls) if (!(await reachable(url))) down.push(name);
  if (down.length === 0) return pass("services", "Langfuse, Keycloak, OpenFGA and Docling answer");
  return fail("services", `no answer from ${down.join(", ")}`, "Wait a minute after a start and run this again. If it stays, run npm run setup.");
}

async function checkModel(): Promise<Result> {
  const { env } = await import("../src/server/env");
  const { modelClient, isBudgetSpent } = await import("../src/server/gateway");
  try {
    const reply = await modelClient().chat.completions.create({
      model: env.openaiModel,
      messages: [{ role: "user", content: "Reply with the word ready." }],
      max_tokens: 5
    });
    if (!reply.choices[0]?.message.content) return fail("model", "the model call came back empty", "Check the OpenRouter connection under AI Gateway in Langfuse.");
    return pass("model", "one model call went through the gateway");
  } catch (error) {
    if (isBudgetSpent(error)) return fail("model", "the medinfo-app key spent its daily budget", "Raise the key's daily budget in Langfuse, under AI Gateway, Gateway keys, or wait until tomorrow.");
    const status = (error as { status?: number }).status;
    if (status === 401 || status === 403) return fail("model", `the gateway refused the key (${status})`, "Copy GATEWAY_KEY_MEDINFO_APP again from Langfuse, under AI Gateway, Gateway keys.");
    return fail("model", `the model call failed${status ? ` (${status})` : ""}`, "Check the OpenRouter key and its credit, under AI Gateway, Connections & Models in Langfuse.");
  }
}

async function checkApp(): Promise<Result> {
  // Not a failure: the doctor also runs before npm run dev. It says so, so a closed page has a reason.
  const up = !(await portFree(3333));
  return pass("app", up ? "npm run dev is running on port 3333" : "npm run dev is not running (start it when you need the app)");
}

export async function diagnose(): Promise<Result[]> {
  const results: Result[] = [checkNodeVersion(), checkDocker(), checkCompose(), checkDisk()];
  const values = readEnv();
  results.push(checkEnv(values));
  if (!results.find((r) => r.id === "docker")!.ok) return results;
  const langfuse = checkStack("langfuse", ["compose", "-f", "langfuse/docker-compose.yml", "-f", "langfuse/workshop.override.yml"]);
  // The infra file reads its passwords from .env, so compose gets the file path, never the values.
  const infra = values
    ? checkStack("infra", ["compose", "--env-file", envFile, "-f", "infra/docker-compose.yml"])
    : { ...fail("infra-stack", "skipped, .env is missing", "Run npm run setup first."), down: SERVICES.infra.map((s) => `infra/${s}`) };
  const { down: langfuseDown, ...langfuseResult } = langfuse;
  const { down: infraDown, ...infraResult } = infra;
  results.push(langfuseResult, infraResult, await checkPorts([...langfuseDown, ...infraDown]));
  if (values) results.push(await checkServices(values));
  if (values && results.find((r) => r.id === "env")!.ok && results.find((r) => r.id === "services")?.ok) results.push(await checkModel());
  results.push(await checkApp());
  return results;
}

async function main() {
  console.log("Checking this machine. Nothing is started or changed.\n");
  const results = await diagnose();
  for (const result of results) {
    console.log(`${result.ok ? "  ok  " : "  FAIL"} ${result.id.padEnd(15)} ${result.line}`);
    if (!result.ok) console.log(`       fix: ${result.fix}\n       more: ${GUIDE}#${result.id}`);
  }
  const failed = results.filter((r) => !r.ok).length;
  console.log(failed ? `\n${failed} problem(s). Fix the first one, then run npm run doctor again.` : "\nEverything checks out.");
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

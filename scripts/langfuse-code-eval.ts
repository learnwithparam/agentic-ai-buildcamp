/**
 * Send Langfuse code evaluators to our own sandbox (lesson 12).
 *
 * Lesson 04 ran them with the insecure-local dispatcher, inside the Langfuse worker, where an
 * evaluator can read the worker's environment. This switches Langfuse to the external dispatcher:
 *   1. writes LANGFUSE_CODE_EVAL_EXTERNAL_SIGNING_SECRET (32 random bytes, hex) to the Langfuse
 *      settings file next to docker-compose.yml, unless one is there. It prints no secret.
 *   2. builds and starts code-eval-executor (src/executor) and restarts langfuse-web and langfuse-worker.
 *   3. proves the two walls: the worker reaches the executor with a signed job, and the executor
 *      cannot reach the internet.
 * Safe to run again.
 *
 *   npm run langfuse:code-eval
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const settingsFile = path.join(root, "langfuse", ".env");
const COMPOSE = ["compose", "-f", "langfuse/docker-compose.yml", "-f", "langfuse/workshop.override.yml"];
const NAME = "LANGFUSE_CODE_EVAL_EXTERNAL_SIGNING_SECRET";

export function secretLine(existing: string): string | null {
  return new RegExp(`^${NAME}=.{32,}$`, "m").test(existing) ? null : `${NAME}=${randomBytes(32).toString("hex")}`;
}

const docker = (args: string[]) => spawnSync("docker", [...COMPOSE, ...args], { cwd: root, encoding: "utf8" });

// Runs inside langfuse-worker, which holds the secret in its own environment, so the secret never
// appears on a command line. It signs a one-line evaluator and posts it the way Langfuse does.
const SIGNED_PROBE = `
const { createHmac } = require("node:crypto");
const body = JSON.stringify({ apiVersion: "v1", scope: {}, runtime: { language: "TYPESCRIPT" }, execution: { jobExecutionId: "probe" },
  code: { source: "function evaluate() { return { scores: [{ name: 'probe', value: 1, dataType: 'NUMERIC' }] }; }" },
  payload: { observation: { input: null, output: null, metadata: null, toolCalls: [] } } });
const t = Math.floor(Date.now() / 1000);
const v1 = createHmac("sha256", process.env.LANGFUSE_CODE_EVAL_EXTERNAL_SIGNING_SECRET).update(t + "." + body).digest("hex");
fetch(process.env.LANGFUSE_CODE_EVAL_EXTERNAL_ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "x-langfuse-signature": "t=" + t + ",v1=" + v1 }, body })
  .then(async (r) => { console.log(r.status, await r.text()); process.exit(r.status === 200 ? 0 : 1); })
  .catch((e) => { console.log(String(e)); process.exit(1); });`;

async function waitFor(label: string, check: () => boolean) {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`${label} was not ready within two minutes. Check: docker ${COMPOSE.join(" ")} logs`);
}

async function main() {
  const existing = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
  const line = secretLine(existing);
  if (line) {
    const joined = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    writeFileSync(settingsFile, `${joined}${line}\n`, { mode: 0o600 });
    console.log("Wrote a new signing secret to langfuse/.env.");
  } else {
    console.log("The signing secret is already in langfuse/.env.");
  }

  execFileSync("docker", [...COMPOSE, "up", "-d", "--build", "code-eval-executor", "langfuse-web", "langfuse-worker"], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"]
  });
  await waitFor("code-eval-executor", () => docker(["ps", "--format", "{{.Health}}", "code-eval-executor"]).stdout.trim() === "healthy");
  await waitFor("langfuse-worker", () => docker(["exec", "-T", "langfuse-worker", "node", "-e", SIGNED_PROBE]).status === 0);
  console.log("Langfuse's worker reached the executor with a signed job and got a score back.");

  // langfuse-web now sits on two networks. Prove the page you open still answers.
  await waitFor("Langfuse on http://localhost:5174", () =>
    spawnSync("curl", ["-s", "-m", "3", "-o", "/dev/null", "-w", "%{http_code}", "http://127.0.0.1:5174/api/public/health"], { encoding: "utf8" }).stdout === "200"
  );
  console.log("Langfuse still answers on http://localhost:5174.");

  const out = docker(["exec", "-T", "code-eval-executor", "wget", "-q", "-T", "3", "-O", "/dev/null", "https://langfuse.com"]);
  if (out.status === 0) throw new Error("The executor reached the internet. Its network must be internal: true.");
  console.log("The executor cannot reach the internet.");
  console.log("Code evaluators now run in the sandbox. Open Langfuse, Evaluators, and run one.");
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) void runMain(main, { name: "Langfuse code evaluators setup" });

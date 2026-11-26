// npm run setup: the whole finished app, from a fresh clone to ready, in one command.
//
// It runs the same scripts the lessons run, in their order, then checks the result. Each step looks
// first and changes only what is missing, so running it again is safe and fast. It never prints a key
// or a password. Lesson 00 teaches these steps one by one; this is for a machine that just needs it to work.
//
//   npm ci && npm run setup && npm run dev
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const LANGFUSE = ["compose", "-f", "langfuse/docker-compose.yml", "-f", "langfuse/workshop.override.yml"];
const MIN_DOCKER_GB = 6;
// The prompt the finished app serves as production: fix 3's per-company prompt, filled in per doctor.
export const PRODUCTION_VARIANT = "per-company";

class Stop extends Error {}

function step(name: string) {
  console.log(`\n== ${name}`);
}

function ok(line: string) {
  console.log(`   ok: ${line}`);
}

function npm(script: string, extraEnv: Record<string, string> = {}, args: string[] = []) {
  const result = spawnSync("npm", ["run", "--silent", script, ...(args.length ? ["--", ...args] : [])], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...extraEnv }
  });
  if (result.status !== 0) throw new Stop(`npm run ${script} failed. Read its output above, fix that, and run npm run setup again.`);
}

// Only the names matter here: the values stay in the file and are never printed.
function readEnv(): Record<string, string | undefined> {
  return parseEnv(readFileSync(envFile, "utf8"));
}

export function checkNode(version: string): string | null {
  const [major, minor] = version.replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 18) ? null : `Node ${version} is too old. Install Node 22.18 or newer.`;
}

export function missingKeys(values: Record<string, string | undefined>, names: string[]): string[] {
  return names.filter((name) => !values[name]?.trim());
}

function checkMachine() {
  step("Node and Docker");
  const node = checkNode(process.version);
  if (node) throw new Stop(node);
  ok(`Node ${process.version}`);
  let bytes: number;
  try {
    bytes = Number(execFileSync("docker", ["info", "--format", "{{.MemTotal}}"], { encoding: "utf8" }).trim());
  } catch {
    throw new Stop("Docker is not running. Start Docker Desktop (or the Docker service), then run npm run setup again.");
  }
  const gb = bytes / 1024 ** 3;
  if (gb < MIN_DOCKER_GB - 0.5) throw new Stop(`Docker has ${gb.toFixed(1)} GB of memory. Give it at least ${MIN_DOCKER_GB} GB in Docker's settings.`);
  ok(`Docker with ${gb.toFixed(1)} GB of memory`);
}

function checkEnvFile() {
  step(".env");
  if (!existsSync(envFile)) {
    copyFileSync(path.join(root, ".env.example"), envFile);
    ok("made .env from .env.example");
  }
  if (missingKeys(readEnv(), ["OPENAI_API_KEY"]).length) {
    throw new Stop("OPENAI_API_KEY is empty. Put your OpenRouter key on that line of .env, then run npm run setup again.");
  }
  ok("OPENAI_API_KEY is set");
}

function startLangfuse() {
  step("Langfuse");
  // The compose file needs the code evaluator's signing secret before any Langfuse container can
  // start. langfuse:code-eval writes it once (and skips it after), then starts the sandbox.
  npm("langfuse:code-eval");
  execFileSync("docker", [...LANGFUSE, "up", "-d", "--wait"], { cwd: root, stdio: "inherit" });
  ok("Langfuse runs at http://localhost:5174");
  npm("langfuse:gateway-keys");
  const missing = missingKeys(readEnv(), ["GATEWAY_KEY_MEDINFO_APP", "GATEWAY_KEY_EVAL_RUNNER"]);
  if (missing.length) {
    throw new Stop(
      [
        `${missing.join(" and ")} ${missing.length > 1 ? "are" : "is"} empty. These keys are made by hand in Langfuse, once:`,
        "  1. Open http://localhost:5174 and sign in as learner@workshop.local (password: workshop-password).",
        "  2. In the organization menu, choose AI Gateway. Pick Usage, in a new project named ai-gateway.",
        "  3. Under Connections & Models, add an OpenRouter connection with your OpenRouter key.",
        "  4. Under Gateway keys, make two Service account keys, medinfo-app and eval-runner,",
        "     each for openrouter:openai/gpt-6-luna with a $1 daily budget.",
        "  5. Paste each key into .env on its line, then run npm run setup again.",
        "Lesson 10, steps 1 to 3, shows each screen."
      ].join("\n")
    );
  }
  ok("both gateway keys are set");
}

async function publishPrompt() {
  step("Production prompt");
  const { LangfuseClient } = await import("@langfuse/client");
  const { env } = await import("../src/server/env");
  const { PROMPT_VARIANTS } = await import("./prompt-variants");
  const langfuse = new LangfuseClient({ publicKey: env.langfusePublicKey, secretKey: env.langfuseSecretKey, baseUrl: env.langfuseBaseUrl });
  const name = env.langfusePromptName || "hcp-medinfo-agent";
  const current = await langfuse.prompt.get(name, { label: "production", cacheTtlSeconds: 0 }).catch(() => null);
  if (current?.prompt === PROMPT_VARIANTS[PRODUCTION_VARIANT]) {
    ok(`"${name}" production is already the ${PRODUCTION_VARIANT} prompt`);
    return;
  }
  npm("prompt:publish", { WORKSHOP_PROMPT_VARIANT: PRODUCTION_VARIANT }, ["--label", "production"]);
}

async function verify() {
  step("Check it works");
  const { LangfuseClient } = await import("@langfuse/client");
  const { env } = await import("../src/server/env");
  const { modelClient } = await import("../src/server/gateway");
  const langfuse = new LangfuseClient({ publicKey: env.langfusePublicKey, secretKey: env.langfuseSecretKey, baseUrl: env.langfuseBaseUrl });
  // Langfuse can miss one request while Docker is short of memory, so ask for up to 30 seconds.
  let datasets: { name: string } | undefined;
  for (let attempt = 1; !datasets; attempt++) {
    try {
      datasets = await langfuse.api.datasets.get(env.datasetName);
    } catch (error) {
      if (attempt === 10) throw new Stop(`Langfuse did not answer at ${env.langfuseBaseUrl} for 30 seconds. Run npm run doctor.`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
  ok(`Langfuse answers, and the dataset "${datasets.name}" is there`);
  const reply = await modelClient().chat.completions.create({
    model: env.openaiModel,
    messages: [{ role: "user", content: "Reply with the word ready." }],
    max_tokens: 5
  });
  if (!reply.choices[0]?.message.content) throw new Stop("The model call through the gateway came back empty. Check the medinfo-app key in Langfuse.");
  ok("one model call went through the gateway");
}

function done() {
  console.log(`
Ready. Start the app:

  npm run dev

  App        http://127.0.0.1:3333
  Langfuse   http://localhost:5174   (learner@workshop.local / workshop-password)

Sign in to the app as one of the seeded users. Their password is SEED_USER_PASSWORD in your .env.
  Doctors            ana.rivera@pharma-a.example.com, lukas.weber@pharma-a.example.com,
                     chidi.okafor@pharma-b.example.com, yui.tanaka@pharma-b.example.com
  Medical reviewers  maya.chen@pharma-a.example.com, sofia.rossi@pharma-b.example.com
  Safety reviewers   omar.haddad@pharma-a.example.com, kenji.mori@pharma-b.example.com
  Sales reps         priya.nair@pharma-a.example.com, lena.fischer@pharma-a.example.com,
                     daniel.cho@pharma-b.example.com, arjun.mehta@pharma-b.example.com
  Analysts           rosa.diaz@pharma-a.example.com, tomas.silva@pharma-b.example.com

With the app running, npm run identity:smoke signs each doctor in through the real login page.`);
}

async function main() {
  try {
    checkMachine();
    checkEnvFile();
    startLangfuse();
    step("Postgres, Keycloak and OpenFGA");
    npm("identity:setup");
    step("Label search");
    npm("rag:setup");
    npm("rag:ingest");
    step("Sales data");
    npm("bi:setup");
    await publishPrompt();
    step("Dataset");
    npm("dataset:seed");
    await verify();
    done();
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    console.error(`\nSetup stopped: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

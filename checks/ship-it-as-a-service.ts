// ship-it-as-a-service: the employee runs as a container from compose.yaml. The checker reads the
// files, then (when Docker is running) builds and starts the service, and reads the container
// state: healthy, the contract answering from inside, a payment in the ledger, the key in the
// container's environment but not in the image, and the jobs and traces still there after the
// container is replaced. With no Docker it says so and checks the files only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cachedRule, expect, fileRule, waitFor } from "./deploy-lib";
import {
  checkerWorld,
  findEmployeeDir,
  freePort,
  type Outcome,
  paymentsFor,
  TRAPS,
  TrialFailed,
} from "./lib";

// An environment variable or build arg with one of these words in its name holds a secret.
const SECRET_NAME = /(KEY|TOKEN|SECRET|PASSWORD)/i;
const COMPOSE_FILE_NAMES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
];

// The parts of a compose.yaml service the checker reads.
type BuildSettings = { context?: string; dockerfile?: string; args?: Record<string, unknown> };
type ComposeService = {
  build?: string | BuildSettings;
  healthcheck?: { test?: unknown };
  restart?: string;
  environment?: string[] | Record<string, unknown>;
  volumes?: (string | { target?: string })[];
};
type ComposeFile = { services?: Record<string, ComposeService> };

// The service that builds the employee, with the files it is built from.
type Service = {
  name: string;
  settings: ComposeService;
  file: string;
  dockerfile: string;
  context: string;
};

function findComposeFile(employeeDir: string): string | undefined {
  const candidates = COMPOSE_FILE_NAMES.map((name) => join(employeeDir, name));
  return candidates.find(existsSync);
}

// The service in compose.yaml that has build:, or a sentence that says what is wrong.
function service(employeeDir: string): Service | string {
  const file = findComposeFile(employeeDir);
  if (!file) return `There is no compose.yaml next to employee.toml in ${employeeDir}.`;
  let compose: ComposeFile;
  try {
    compose = Bun.YAML.parse(readFileSync(file, "utf8")) as ComposeFile;
  } catch (error) {
    return `compose.yaml does not parse: ${(error as Error).message}`;
  }
  const services = Object.entries(compose?.services ?? {});
  const built = services.find(([, settings]) => settings?.build);
  if (!built) {
    return (
      "compose.yaml has no service with build:. " +
      "Build the employee's image from your Dockerfile."
    );
  }
  const [name, settings] = built;
  let build = settings.build as BuildSettings;
  if (typeof settings.build === "string") build = { context: settings.build };
  const context = resolve(employeeDir, build.context ?? ".");
  const dockerfile = resolve(context, build.dockerfile ?? "Dockerfile");
  return { name, settings, file, context, dockerfile };
}

// The service's environment: block as name to value, in either of the forms compose allows.
function serviceEnvironment(settings: ComposeService): Record<string, string> {
  const environment = settings.environment ?? {};
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment.map((line) => {
        const [name, ...valueParts] = line.split("=");
        return [name, valueParts.join("=")];
      }),
    );
  }
  return Object.fromEntries(
    Object.entries(environment).map(([name, value]) => {
      if (value === null) return [name, ""];
      return [name, String(value)];
    }),
  );
}

// The NAME=value pairs set by ENV lines in a Dockerfile.
function dockerfileEnvironment(text: string): Record<string, string> {
  const environment: Record<string, string> = {};
  const envLines = text.split("\n").filter((line) => /^\s*ENV\s/i.test(line));
  for (const line of envLines) {
    const pairs = line.replace(/^\s*ENV\s+/i, "");
    for (const pair of pairs.matchAll(/(\w+)=("[^"]*"|\S+)/g)) {
      environment[pair[1]] = pair[2].replace(/^"|"$/g, "");
    }
  }
  return environment;
}

function restartsAfterCrash(restart: string | undefined): boolean {
  if (restart === "always" || restart === "unless-stopped") return true;
  return String(restart ?? "").startsWith("on-failure");
}

function healthProblem(employeeDir: string): string | null {
  const found = service(employeeDir);
  if (typeof found === "string") return found;
  const test = JSON.stringify(found.settings.healthcheck?.test ?? "");
  if (!test.includes("/health")) {
    return `Service "${found.name}" has no healthcheck that calls /health.`;
  }
  if (!restartsAfterCrash(found.settings.restart)) {
    return (
      `Service "${found.name}" has restart: ${found.settings.restart ?? "(none)"}. ` +
      "Use unless-stopped so a crash brings it back."
    );
  }
  return null;
}

// A key in ENV or ARG, or a copied .env file, ends up inside the image.
function dockerfileSecretProblem(dockerfile: string): string | null {
  const lines = readFileSync(dockerfile, "utf8").split("\n");
  const baked = lines.find((line) => /^\s*(ENV|ARG)\s/i.test(line) && SECRET_NAME.test(line));
  if (baked) {
    return (
      `The Dockerfile says "${baked.trim()}". ` +
      "A key in ENV or ARG is saved in the image for anyone who pulls it."
    );
  }
  const copied = lines.find(
    (line) => /^\s*(COPY|ADD)\s/i.test(line) && /(^|\s|\/)\.env(\s|$)/.test(line),
  );
  if (copied) {
    return (
      `The Dockerfile says "${copied.trim()}". ` +
      "The .env file holds keys; keep it out of the image."
    );
  }
  return null;
}

function dockerignoreProblem(found: Service): string | null {
  const nextToDockerfile = `${found.dockerfile}.dockerignore`;
  const inContext = join(found.context, ".dockerignore");
  const ignoreFile = [nextToDockerfile, inContext].find(existsSync);
  if (ignoreFile) {
    const lines = readFileSync(ignoreFile, "utf8").split("\n");
    const listsEnv = lines.some((line) => /^(\*\*\/)?\.env\b/.test(line.trim()));
    if (listsEnv) return null;
  }
  return `No dockerignore lists .env (looked for ${nextToDockerfile} and ${inContext}).`;
}

// compose.yaml must pass keys at run time, from the environment, never as build args or values.
function composeSecretProblem(found: Service): string | null {
  const build = found.settings.build;
  const buildArgs = typeof build === "object" ? build.args : undefined;
  if (buildArgs && Object.keys(buildArgs).some((name) => SECRET_NAME.test(name))) {
    return (
      "compose.yaml passes a key as a build arg, which saves it in the image. " +
      "Pass it in environment instead."
    );
  }
  const written = Object.entries(serviceEnvironment(found.settings)).find(
    ([name, value]) => SECRET_NAME.test(name) && value && !value.trim().startsWith("${"),
  );
  if (written) {
    const name = written[0];
    return (
      `compose.yaml writes ${name} as a value. ` +
      `Write ${name}: \${${name}} so it comes from the environment or .env.`
    );
  }
  return null;
}

function secretProblem(employeeDir: string): string | null {
  const found = service(employeeDir);
  if (typeof found === "string") return found;
  if (!existsSync(found.dockerfile)) {
    return `compose.yaml builds from ${found.dockerfile}, which does not exist.`;
  }
  return (
    dockerfileSecretProblem(found.dockerfile) ??
    dockerignoreProblem(found) ??
    composeSecretProblem(found)
  );
}

// The folders inside the container that have a volume mounted on them.
function volumeTargets(settings: ComposeService): string[] {
  const targets = (settings.volumes ?? []).map((volume) => {
    if (typeof volume === "string") return volume.split(":")[1];
    return volume?.target;
  });
  return targets.filter(Boolean) as string[];
}

function isInside(folder: string, mountedAt: string): boolean {
  if (folder === mountedAt) return true;
  let prefix = `${mountedAt}/`;
  if (mountedAt.endsWith("/")) prefix = mountedAt;
  return folder.startsWith(prefix);
}

function volumeProblem(employeeDir: string): string | null {
  const found = service(employeeDir);
  if (typeof found === "string") return found;
  let fromDockerfile: Record<string, string> = {};
  if (existsSync(found.dockerfile)) {
    fromDockerfile = dockerfileEnvironment(readFileSync(found.dockerfile, "utf8"));
  }
  const environment = { ...fromDockerfile, ...serviceEnvironment(found.settings) };
  const targets = volumeTargets(found.settings);
  for (const name of ["TRACE_DIR", "STATE_DIR"]) {
    const folder = environment[name];
    if (!folder) {
      return (
        `Neither compose.yaml nor the Dockerfile sets ${name}. ` +
        "Set it to a folder inside the container."
      );
    }
    if (!targets.some((target) => isInside(folder, target))) {
      return `${name} is ${folder}, and no volume is mounted there, so it dies with the container.`;
    }
  }
  return null;
}

// Why the container cannot be checked here, or null when Docker and compose are ready.
function dockerMissing(): string | null {
  if (process.env.CHECK_DOCKER === "0") return "CHECK_DOCKER=0";
  const info = spawnSync("docker", ["info"], { timeout: 15_000 });
  if (info.status !== 0) return "Docker is not running here";
  const compose = spawnSync("docker", ["compose", "version"], { timeout: 15_000 });
  if (compose.status !== 0) return "docker compose is not installed";
  return null;
}

type CommandResult = { ok: boolean; out: string; err: string };

// One running copy of the service, with the names and the key this check gave it.
type Deployment = {
  service: Service;
  world: ReturnType<typeof checkerWorld>;
  base: string;
  nonce: string;
  key: string;
  docker: (args: string[]) => CommandResult;
  compose: (...args: string[]) => CommandResult;
};

async function newDeployment(found: Service): Promise<Deployment> {
  const world = checkerWorld();
  const port = await freePort();
  const nonce = Math.random().toString(36).slice(2, 8);
  const project = `deploycheck${nonce}`;
  const key = `checker-not-a-real-key-${nonce}`;
  const environment: Record<string, string> = { ...(process.env as Record<string, string>) };
  environment.PORT = String(port);
  environment.WORLD_URL = `http://host.docker.internal:${world.port}`;
  environment.ANTHROPIC_API_KEY = key;
  environment.MODEL_MODE = "replay";
  const docker = (args: string[]): CommandResult => {
    const options = { cwd: dirname(found.file), env: environment, timeout: 300_000 };
    const result = spawnSync("docker", args, options);
    const errors = result.stderr?.toString() ?? "";
    return {
      ok: result.status === 0,
      out: result.stdout?.toString() ?? "",
      err: errors.slice(-600),
    };
  };
  const compose = (...args: string[]) =>
    docker(["compose", "-f", found.file, "-p", project, ...args]);
  return { service: found, world, base: `http://localhost:${port}`, nonce, key, docker, compose };
}

async function getJson(url: string) {
  return fetch(url)
    .then((response) => response.json())
    .catch(() => null);
}

// docker compose ps prints one JSON array, or one JSON object per line, by version.
// Docker prints these fields in PascalCase, so the types keep Docker's names.
// biome-ignore lint/style/useNamingConvention: the field names are Docker's.
type ComposeRow = { Health?: string; State?: string };

function composeRows(printed: string): ComposeRow[] {
  const text = printed.trim();
  if (text.startsWith("[")) return JSON.parse(text);
  const lines = text.split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line));
}

async function comesUpHealthy(deployment: Deployment) {
  const { compose, service: found, base } = deployment;
  const started = compose("up", "-d", "--build", "--wait", "--wait-timeout", "120");
  expect(started.ok, `docker compose up --wait did not finish healthy:\n${started.err}`);
  const rows = composeRows(compose("ps", "--format", "json", found.name).out);
  expect(
    rows[0]?.Health === "healthy",
    `docker compose ps says ${found.name} is "${rows[0]?.Health || rows[0]?.State}", not healthy.`,
  );
  const health = (await getJson(`${base}/health`)) as { contract?: unknown } | null;
  expect(
    String(health?.contract) === "1",
    `GET ${base}/health from the container answered ${JSON.stringify(health)}. ` +
      `Publish the container's port on \${PORT:-7701}.`,
  );
}

async function startJob(base: string, jobId: string, invoice: string) {
  const body = {
    job_id: jobId,
    tenant: "kaas-freight",
    trigger: { kind: "person", by: "ravi" },
    input: { invoice_id: invoice },
  };
  const answer = await fetch(`${base}/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
    .then((response) => response.json())
    .catch(() => null);
  return answer as { run_id?: unknown } | null;
}

// The container takes a job and pays it in the checker's world. Returns the job's run id.
async function paysFromInside(deployment: Deployment, jobId: string): Promise<unknown> {
  const { base, world } = deployment;
  const invoice = TRAPS.clean.invoice_ids[5];
  const started = await startJob(base, jobId, invoice);
  const paid = await waitFor(() => paymentsFor(world, invoice).length > 0, 20_000);
  expect(
    paid,
    `The container took job ${jobId} but the ledger shows no payment for ${invoice}. ` +
      `Set WORLD_URL from the environment (\${WORLD_URL:-http://host.docker.internal:7700}) ` +
      "and add extra_hosts: host.docker.internal:host-gateway.",
  );
  await waitFor(async () => {
    const job = (await getJson(`${base}/jobs/${jobId}`)) as { status?: string } | null;
    return job?.status === "done";
  }, 10_000);
  return started?.run_id;
}

// biome-ignore lint/style/useNamingConvention: the field names are Docker's.
type ContainerInfo = { Image: string; Config?: { Env?: string[] } };
// biome-ignore lint/style/useNamingConvention: the field names are Docker's.
type ImageInfo = { Config?: { Env?: string[] } };

// The key the checker set reaches the container's environment, and never the image.
function keyOnlyInTheEnvironment(deployment: Deployment) {
  const { compose, docker, service: found, key } = deployment;
  const containerId = compose("ps", "-q", found.name).out.trim();
  const containers = JSON.parse(docker(["inspect", containerId]).out || "[]") as ContainerInfo[];
  const container = containers[0];
  expect(
    (container?.Config?.Env ?? []).includes(`ANTHROPIC_API_KEY=${key}`),
    "The checker set ANTHROPIC_API_KEY in the environment and the container does not have it. " +
      `List it under environment: as ANTHROPIC_API_KEY: \${ANTHROPIC_API_KEY}.`,
  );
  const images = JSON.parse(docker(["image", "inspect", container.Image]).out || "[]");
  const image = (images as ImageInfo[])[0];
  const historyArgs = ["history", "--no-trunc", "--format", "{{.CreatedBy}}", container.Image];
  const history = docker(historyArgs).out;
  const inImageEnv = JSON.stringify(image?.Config?.Env ?? []).includes(key);
  expect(
    !inImageEnv && !history.includes(key),
    "The key the checker set is saved in the image (its ENV or its build history). " +
      "Anyone who pulls the image can read it.",
  );
}

function tracesInside(deployment: Deployment): string {
  const { compose, service: found } = deployment;
  return compose("exec", "-T", found.name, "sh", "-c", 'cat "$TRACE_DIR"/*.jsonl').out;
}

function wroteTrace(deployment: Deployment, runId: unknown) {
  const traces = tracesInside(deployment);
  expect(
    runId && traces.includes(String(runId)) && traces.includes("invoke_agent"),
    `No trace for run ${runId} in TRACE_DIR inside the container. Write traces to TRACE_DIR.`,
  );
}

// Replace the container. The volumes stay, so the job and its trace must still be there.
async function survivesReplacement(deployment: Deployment, jobId: string, runId: unknown) {
  const { compose, base } = deployment;
  const replaced = compose("down").ok && compose("up", "-d", "--wait", "--wait-timeout", "120").ok;
  expect(replaced, "docker compose down then up --wait did not come back healthy.");
  const again = (await getJson(`${base}/jobs/${jobId}`)) as { status?: string } | null;
  expect(
    again?.status === "done",
    `After docker compose down and up, GET /jobs/${jobId} answered ${JSON.stringify(again)}. ` +
      "Keep STATE_DIR on a named volume.",
  );
  expect(
    tracesInside(deployment).includes(String(runId)),
    `After docker compose down and up, the trace for run ${runId} is gone. ` +
      "Keep TRACE_DIR on a named volume.",
  );
}

async function checkRunningContainer(deployment: Deployment) {
  const jobId = `container-${deployment.nonce}`;
  await comesUpHealthy(deployment);
  const runId = await paysFromInside(deployment, jobId);
  keyOnlyInTheEnvironment(deployment);
  wroteTrace(deployment, runId);
  await survivesReplacement(deployment, jobId, runId);
}

// The file rules must pass before the checker spends minutes building the image.
function filesProblem(dir: string): string | null {
  let employeeDir: string;
  try {
    employeeDir = findEmployeeDir(dir);
  } catch (error) {
    return (error as Error).message;
  }
  const problem =
    healthProblem(employeeDir) ?? secretProblem(employeeDir) ?? volumeProblem(employeeDir);
  if (problem) return `The container was not started: fix the file rules above first. ${problem}`;
  return null;
}

async function container(dir: string): Promise<Outcome> {
  const problem = filesProblem(dir);
  if (problem) return { ok: false, message: problem };
  const whyNot = dockerMissing();
  if (whyNot) {
    const message =
      `SKIPPED: ${whyNot}, so the container was not built or started. ` +
      "This rule has not passed yet. Start Docker and run this again to check the container.";
    return { ok: false, skipped: true, message };
  }
  const deployment = await newDeployment(service(findEmployeeDir(dir)) as Service);
  try {
    await checkRunningContainer(deployment);
    return { ok: true, message: "The container passed." };
  } catch (error) {
    if (error instanceof TrialFailed) return { ok: false, message: error.message };
    throw error;
  } finally {
    deployment.compose("down", "-v", "--rmi", "local");
    deployment.world.stop();
  }
}

export default [
  fileRule(
    "compose.yaml runs the employee with a health check on /health and a restart policy",
    "add a service with build:, a healthcheck whose test calls /health, " +
      "and restart: unless-stopped",
    healthProblem,
  ),
  fileRule(
    "no key is baked into the image: none in the Dockerfile or build args, " +
      "and a dockerignore keeps .env out",
    "take every key out of ENV and ARG, list .env in a dockerignore, " +
      `and pass keys in compose environment as \${NAME}`,
    secretProblem,
  ),
  fileRule(
    "traces and saved jobs live on volumes, so they outlive the container",
    "set TRACE_DIR and STATE_DIR to folders inside the container and mount a named volume on each",
    volumeProblem,
  ),
  cachedRule(
    "container",
    "the container comes up healthy, pays from inside, keeps the key out of the image, " +
      "and keeps its jobs and traces when replaced",
    "run docker compose up -d --build --wait yourself and read its output; " +
      "then docker compose ps and docker compose logs",
    container,
  ),
];

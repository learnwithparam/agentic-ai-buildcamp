// ship-it-as-a-service: the employee runs as a container from compose.yaml. The checker reads the files, then (when
// Docker is running) builds and starts the service, and reads the container state: healthy, the contract answering
// from inside, a payment in the ledger, the key in the container's environment but not in the image, and the jobs
// and traces still there after the container is replaced. With no Docker it says so and checks the files only.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { cachedRule, fileRule, waitFor } from "./deploy-lib";
import { checkerWorld, findEmployeeDir, freePort, type Outcome, paymentsFor, TRAPS } from "./lib";

const SECRET = /(KEY|TOKEN|SECRET|PASSWORD)/i;
type Svc = { name: string; svc: any; file: string; dockerfile: string; context: string };

function service(empDir: string): Svc | string {
  const file = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"]
    .map((f) => join(empDir, f))
    .find(existsSync);
  if (!file) return `There is no compose.yaml next to employee.toml in ${empDir}.`;
  let doc: any;
  try {
    doc = Bun.YAML.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return `compose.yaml does not parse: ${(e as Error).message}`;
  }
  const entry = Object.entries(doc?.services ?? {}).find(([, s]: any) => s?.build);
  if (!entry)
    return "compose.yaml has no service with build:. Build the employee's image from your Dockerfile.";
  const [name, svc] = entry as [string, any];
  const b = typeof svc.build === "string" ? { context: svc.build } : svc.build;
  const context = resolve(empDir, b.context ?? ".");
  return { name, svc, file, context, dockerfile: resolve(context, b.dockerfile ?? "Dockerfile") };
}

const envMap = (svc: any): Record<string, string> => {
  const e = svc.environment ?? {};
  if (Array.isArray(e))
    return Object.fromEntries(
      e.map((x: string) => [x.split("=")[0], x.split("=").slice(1).join("=")]),
    );
  return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, v === null ? "" : String(v)]));
};
const dockerfileEnv = (text: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const line of text.split("\n").filter((l) => /^\s*ENV\s/i.test(l)))
    for (const m of line.replace(/^\s*ENV\s+/i, "").matchAll(/(\w+)=("[^"]*"|\S+)/g))
      out[m[1]] = m[2].replace(/^"|"$/g, "");
  return out;
};

function healthProblem(empDir: string): string | null {
  const s = service(empDir);
  if (typeof s === "string") return s;
  const test = JSON.stringify(s.svc.healthcheck?.test ?? "");
  if (!test.includes("/health"))
    return `Service "${s.name}" has no healthcheck that calls /health.`;
  if (
    !["always", "unless-stopped"].includes(s.svc.restart) &&
    !String(s.svc.restart ?? "").startsWith("on-failure")
  )
    return `Service "${s.name}" has restart: ${s.svc.restart ?? "(none)"}. Use unless-stopped so a crash brings it back.`;
  return null;
}

function secretProblem(empDir: string): string | null {
  const s = service(empDir);
  if (typeof s === "string") return s;
  if (!existsSync(s.dockerfile))
    return `compose.yaml builds from ${s.dockerfile}, which does not exist.`;
  const lines = readFileSync(s.dockerfile, "utf8").split("\n");
  const baked = lines.find((l) => /^\s*(ENV|ARG)\s/i.test(l) && SECRET.test(l));
  if (baked)
    return `The Dockerfile says "${baked.trim()}". A key in ENV or ARG is saved in the image for anyone who pulls it.`;
  const copied = lines.find((l) => /^\s*(COPY|ADD)\s/i.test(l) && /(^|\s|\/)\.env(\s|$)/.test(l));
  if (copied)
    return `The Dockerfile says "${copied.trim()}". The .env file holds keys; keep it out of the image.`;
  const ignore = [`${s.dockerfile}.dockerignore`, join(s.context, ".dockerignore")].find(
    existsSync,
  );
  if (
    !ignore ||
    !readFileSync(ignore, "utf8")
      .split("\n")
      .some((l) => /^(\*\*\/)?\.env\b/.test(l.trim()))
  )
    return `No dockerignore lists .env (looked for ${s.dockerfile}.dockerignore and ${join(s.context, ".dockerignore")}).`;
  if (s.svc.build?.args && Object.keys(s.svc.build.args).some((k) => SECRET.test(k)))
    return "compose.yaml passes a key as a build arg, which saves it in the image. Pass it in environment instead.";
  const literal = Object.entries(envMap(s.svc)).find(
    ([k, v]) => SECRET.test(k) && v && !v.trim().startsWith("${"),
  );
  if (literal)
    return `compose.yaml writes ${literal[0]} as a value. Write ${literal[0]}: \${${literal[0]}} so it comes from the environment or .env.`;
  return null;
}

function volumeProblem(empDir: string): string | null {
  const s = service(empDir);
  if (typeof s === "string") return s;
  const env = {
    ...(existsSync(s.dockerfile) ? dockerfileEnv(readFileSync(s.dockerfile, "utf8")) : {}),
    ...envMap(s.svc),
  };
  const targets = (s.svc.volumes ?? [])
    .map((v: any) => (typeof v === "string" ? v.split(":")[1] : v?.target))
    .filter(Boolean) as string[];
  for (const k of ["TRACE_DIR", "STATE_DIR"]) {
    const d = env[k];
    if (!d)
      return `Neither compose.yaml nor the Dockerfile sets ${k}. Set it to a folder inside the container.`;
    if (!targets.some((t) => d === t || d.startsWith(t.endsWith("/") ? t : `${t}/`)))
      return `${k} is ${d}, and no volume is mounted there, so it dies with the container.`;
  }
  return null;
}

function docker(): string | null {
  if (process.env.CHECK_DOCKER === "0") return "CHECK_DOCKER=0";
  const info = spawnSync("docker", ["info"], { timeout: 15_000 });
  if (info.status !== 0) return "Docker is not running here";
  if (spawnSync("docker", ["compose", "version"], { timeout: 15_000 }).status !== 0)
    return "docker compose is not installed";
  return null;
}

async function container(dir: string): Promise<Outcome> {
  let empDir: string;
  try {
    empDir = findEmployeeDir(dir);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  const first = healthProblem(empDir) ?? secretProblem(empDir) ?? volumeProblem(empDir);
  if (first)
    return {
      ok: false,
      message: `The container was not started: fix the file rules above first. ${first}`,
    };
  const why = docker();
  if (why) {
    console.log(
      `        SKIPPED: ${why}, so the container was not built or started. The file rules above still apply. Start Docker and run this again to check the container.`,
    );
    return { ok: true, message: "skipped" };
  }
  const s = service(empDir) as Svc;
  const world = checkerWorld();
  const port = await freePort();
  const nonce = Math.random().toString(36).slice(2, 8);
  const project = `deploycheck${nonce}`,
    key = `checker-not-a-real-key-${nonce}`;
  const env = {
    ...(process.env as Record<string, string>),
    PORT: String(port),
    WORLD_URL: `http://host.docker.internal:${world.port}`,
    ANTHROPIC_API_KEY: key,
    MODEL_MODE: "replay",
  };
  const run = (cmd: string[], timeout = 300_000) => {
    const r = spawnSync("docker", cmd, { cwd: dirname(s.file), env, timeout });
    return {
      ok: r.status === 0,
      out: r.stdout?.toString() ?? "",
      err: (r.stderr?.toString() ?? "").slice(-600),
    };
  };
  const dc = (...a: string[]) => run(["compose", "-f", s.file, "-p", project, ...a]);
  const fail = (message: string): Outcome => ({ ok: false, message });
  try {
    const up = dc("up", "-d", "--build", "--wait", "--wait-timeout", "120");
    if (!up.ok) return fail(`docker compose up --wait did not finish healthy:\n${up.err}`);
    const ps = dc("ps", "--format", "json", s.name);
    const rows = ps.out.trim().startsWith("[")
      ? JSON.parse(ps.out)
      : ps.out
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((l) => JSON.parse(l));
    if (rows[0]?.Health !== "healthy")
      return fail(
        `docker compose ps says ${s.name} is "${rows[0]?.Health || rows[0]?.State}", not healthy.`,
      );
    const base = `http://localhost:${port}`;
    const h = await fetch(`${base}/health`)
      .then((r) => r.json())
      .catch(() => null);
    if (String(h?.contract) !== "1")
      return fail(
        `GET ${base}/health from the container answered ${JSON.stringify(h)}. Publish the container's port on \${PORT:-7701}.`,
      );

    const inv = TRAPS.clean.invoice_ids[5];
    const jobId = `container-${nonce}`;
    const started = await fetch(`${base}/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        job_id: jobId,
        tenant: "kaas-freight",
        trigger: { kind: "person", by: "ravi" },
        input: { invoice_id: inv },
      }),
    })
      .then((r) => r.json())
      .catch(() => null);
    const paid = await waitFor(() => paymentsFor(world, inv).length > 0, 20_000);
    if (!paid)
      return fail(
        `The container took job ${jobId} but the ledger shows no payment for ${inv}. Set WORLD_URL from the environment (\${WORLD_URL:-http://host.docker.internal:7700}) and add extra_hosts: host.docker.internal:host-gateway.`,
      );
    await waitFor(
      async () =>
        (
          await fetch(`${base}/jobs/${jobId}`)
            .then((r) => r.json())
            .catch(() => ({}))
        )?.status === "done",
      10_000,
    );

    const id = dc("ps", "-q", s.name).out.trim();
    const cont = JSON.parse(run(["inspect", id]).out || "[]")[0];
    if (!(cont?.Config?.Env ?? []).includes(`ANTHROPIC_API_KEY=${key}`))
      return fail(
        "The checker set ANTHROPIC_API_KEY in the environment and the container does not have it. List it under environment: as ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}.",
      );
    const image = JSON.parse(run(["image", "inspect", cont.Image]).out || "[]")[0];
    const history = run(["history", "--no-trunc", "--format", "{{.CreatedBy}}", cont.Image]).out;
    if (JSON.stringify(image?.Config?.Env ?? []).includes(key) || history.includes(key))
      return fail(
        "The key the checker set is saved in the image (its ENV or its build history). Anyone who pulls the image can read it.",
      );
    const traces = dc("exec", "-T", s.name, "sh", "-c", 'cat "$TRACE_DIR"/*.jsonl');
    if (
      !started?.run_id ||
      !traces.out.includes(String(started.run_id)) ||
      !traces.out.includes("invoke_agent")
    )
      return fail(
        `No trace for run ${started?.run_id} in TRACE_DIR inside the container. Write traces to TRACE_DIR.`,
      );

    // Replace the container. The volumes stay, so the job and its trace must still be there.
    if (!dc("down").ok || !dc("up", "-d", "--wait", "--wait-timeout", "120").ok)
      return fail("docker compose down then up --wait did not come back healthy.");
    const again = await fetch(`${base}/jobs/${jobId}`)
      .then((r) => r.json())
      .catch(() => null);
    if (again?.status !== "done")
      return fail(
        `After docker compose down and up, GET /jobs/${jobId} answered ${JSON.stringify(again)}. Keep STATE_DIR on a named volume.`,
      );
    if (
      !dc("exec", "-T", s.name, "sh", "-c", 'cat "$TRACE_DIR"/*.jsonl').out.includes(
        String(started.run_id),
      )
    )
      return fail(
        `After docker compose down and up, the trace for run ${started.run_id} is gone. Keep TRACE_DIR on a named volume.`,
      );
    return { ok: true, message: "The container passed." };
  } finally {
    dc("down", "-v", "--rmi", "local");
    world.stop();
  }
}

export default [
  fileRule(
    "compose.yaml runs the employee with a health check on /health and a restart policy",
    "add a service with build:, a healthcheck whose test calls /health, and restart: unless-stopped",
    healthProblem,
  ),
  fileRule(
    "no key is baked into the image: none in the Dockerfile or build args, and a dockerignore keeps .env out",
    "take every key out of ENV and ARG, list .env in a dockerignore, and pass keys in compose environment as ${NAME}",
    secretProblem,
  ),
  fileRule(
    "traces and saved jobs live on volumes, so they outlive the container",
    "set TRACE_DIR and STATE_DIR to folders inside the container and mount a named volume on each",
    volumeProblem,
  ),
  cachedRule(
    "container",
    "the container comes up healthy, pays from inside, keeps the key out of the image, and keeps its jobs and traces when replaced",
    "run docker compose up -d --build --wait yourself and read its output; then docker compose ps and docker compose logs",
    container,
  ),
];

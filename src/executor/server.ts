import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Worker } from "node:worker_threads";
import { LIMITS, type Outcome } from "./sandbox.ts";

// Lesson 12. The external code-evaluator executor Langfuse calls when
// LANGFUSE_CODE_EVAL_DISPATCHER=external. It follows Langfuse's v1 contract:
//   - POST a JSON job, signed: x-langfuse-signature: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">
//   - 200 with { scores } when the evaluator ran, 422 with { error: { code, message } } when it failed,
//     401 when the signature is wrong or older than five minutes (Langfuse does not retry a 401).
// It runs inside the Langfuse compose on a network with no way out, so even a bug in the sandbox
// reaches nothing but this process. Start it with:  node src/executor/server.ts

export const MAX_BODY_BYTES = 5.5 * 1024 * 1024;
export const MAX_SOURCE_BYTES = 256 * 1024;
export const SIGNATURE_WINDOW_SECONDS = 300;

export function sign(secret: string, body: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const digest = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

export function verifySignature(secret: string, header: string | undefined, body: string, now = Math.floor(Date.now() / 1000)): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((part) => part.trim().split("=", 2) as [string, string]));
  const timestamp = Number(parts.t);
  if (!Number.isInteger(timestamp) || !/^[0-9a-f]{64}$/.test(parts.v1 ?? "")) return false;
  if (Math.abs(now - timestamp) > SIGNATURE_WINDOW_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest();
  return timingSafeEqual(expected, Buffer.from(parts.v1, "hex"));
}

type Job = {
  apiVersion?: string;
  runtime?: { language?: string };
  code?: { source?: string };
  payload?: unknown;
};

function send(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBody(request: IncomingMessage): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        resolve(null);
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });
}

// The hard limit: QuickJS's own deadline plus a little, after which the thread is ended.
export const HARD_LIMIT_MS = LIMITS.timeMs + 500;

// Each evaluation runs in its own thread with its own memory cap, ended at HARD_LIMIT_MS.
export function runIsolated(source: string, payload: unknown, limitMs = HARD_LIMIT_MS): Promise<Outcome> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL("./worker.ts", import.meta.url), {
      workerData: { source, payload },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    });
    const timer = setTimeout(() => {
      void worker.terminate();
      resolve({ error: { code: "TIMEOUT", message: `The evaluator ran longer than ${LIMITS.timeMs / 1000} seconds.` } });
    }, limitMs);
    const finish = (outcome: Outcome) => {
      clearTimeout(timer);
      resolve(outcome);
      void worker.terminate();
    };
    worker.once("message", finish);
    worker.once("error", (error) =>
      finish({ error: { code: /memory/i.test(String(error)) ? "OUT_OF_MEMORY" : "USER_CODE_ERROR", message: "The evaluator stopped unexpectedly." } })
    );
  });
}

// Evaluations run one at a time, so a burst of jobs cannot exhaust the container; Langfuse queues them.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task, task);
  queue = next.catch(() => undefined);
  return next;
}

export function createExecutor(secret: string): Server {
  if (secret.length < 32) throw new Error("The signing secret must be at least 32 characters.");
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") return send(response, 200, { ok: true });
    if (request.method !== "POST") return send(response, 405, { error: { code: "METHOD_NOT_ALLOWED", message: "POST a job." } });

    const body = await readBody(request);
    if (body === null) return send(response, 413, { error: { code: "PAYLOAD_TOO_LARGE", message: "The job is larger than 5.5 MB." } });
    const header = request.headers["x-langfuse-signature"];
    if (!verifySignature(secret, Array.isArray(header) ? header[0] : header, body)) {
      return send(response, 401, { error: { code: "UNAUTHORIZED", message: "Missing, wrong or expired signature." } });
    }

    let job: Job;
    try {
      job = JSON.parse(body);
    } catch {
      return send(response, 400, { error: { code: "BAD_REQUEST", message: "The job is not JSON." } });
    }
    if (job.apiVersion !== "v1") return send(response, 400, { error: { code: "BAD_REQUEST", message: "Only apiVersion v1 is supported." } });
    if (job.runtime?.language !== "TYPESCRIPT") {
      return send(response, 422, { error: { code: "UNSUPPORTED_RUNTIME", message: "This executor runs TypeScript evaluators only." } });
    }
    const source = job.code?.source;
    if (typeof source !== "string" || source.length === 0 || Buffer.byteLength(source) > MAX_SOURCE_BYTES) {
      return send(response, 422, { error: { code: "INVALID_SOURCE", message: "The evaluator source is missing or larger than 256 KB." } });
    }

    const outcome: Outcome = await serial(() => runIsolated(source, job.payload ?? {}));
    return "error" in outcome ? send(response, 422, outcome) : send(response, 200, outcome);
  });
}

const isDirectRun = Boolean(process.argv[1]) && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isDirectRun) {
  const secret = process.env.LANGFUSE_CODE_EVAL_EXTERNAL_SIGNING_SECRET ?? "";
  const port = Number(process.env.PORT ?? 8080);
  createExecutor(secret).listen(port, "0.0.0.0", () => console.log(`Code evaluator executor listening on ${port}`));
}

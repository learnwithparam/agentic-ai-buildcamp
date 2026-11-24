import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { transformSync } from "amaro";
import { after, before, test } from "node:test";
import vm from "node:vm";
import { ALL_CAPS, ENV_READER, FOREVER, MEMORY_HOG } from "./planted.ts";
import { runEvaluator } from "./sandbox.ts";
import { createExecutor, runIsolated, sign } from "./server.ts";

// Lesson 12: Langfuse code evaluators run in a sandbox, not in the Langfuse worker.
const SECRET = "test-signing-secret-that-is-long-enough-0123";
const observation = (input: unknown) => ({ observation: { input, output: null, metadata: null, toolCalls: [] } });

test("the lesson 04 evaluator still scores inside the sandbox", async () => {
  assert.deepEqual(await runEvaluator(ALL_CAPS, observation("WHY IS MY PATIENT STILL DIZZY")), {
    scores: [{ name: "user_frustration", value: true, dataType: "BOOLEAN", comment: "100% capitals" }]
  });
  assert.deepEqual(await runEvaluator(ALL_CAPS, observation("What is the starting dose?")), {
    scores: [{ name: "user_frustration", value: false, dataType: "BOOLEAN", comment: "5% capitals" }]
  });
});

// The same line under node:vm, the way the insecure-local dispatcher runs it, reaches the host.
test("node:vm leaks the host's environment to an evaluator", () => {
  process.env.PLANTED_DEMO_SECRET = "never-printed";
  try {
    const context = vm.createContext({ console });
    vm.runInContext(transformSync(ENV_READER, { mode: "strip-only" }).code, context);
    const result = vm.runInContext("evaluate()", context) as { scores: { comment: string }[] };
    assert.match(result.scores[0].comment, /PLANTED_DEMO_SECRET/);
    assert.doesNotMatch(result.scores[0].comment, /never-printed/, "the demo prints names, never values");
  } finally {
    delete process.env.PLANTED_DEMO_SECRET;
  }
});

test("the sandbox has no host to climb to", async () => {
  const outcome = await runEvaluator(ENV_READER, observation("hi"));
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "USER_CODE_ERROR");
});

test("a loop that never ends is stopped at the time limit", async () => {
  const started = Date.now();
  const outcome = await runEvaluator(FOREVER, observation("hi"));
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "TIMEOUT");
  assert.ok(Date.now() - started < 4_000, "stopped well inside Langfuse's own 10 second request limit");
});

test("an evaluator that eats memory is stopped at the memory limit", async () => {
  const started = Date.now();
  const before = process.memoryUsage().rss;
  const outcome = await runEvaluator(MEMORY_HOG, observation("hi"));
  const grew = process.memoryUsage().rss - before;
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "OUT_OF_MEMORY");
  assert.ok(Date.now() - started < 4_000, "stopped well inside Langfuse's own 10 second request limit");
  // The container has 512 MB. Without the WebAssembly cap this one evaluator took over 1 GB.
  assert.ok(grew < 256 * 1024 * 1024, `the evaluator grew the process by ${Math.round(grew / 1024 / 1024)} MB`);
});

test("the same evaluator through the server's thread comes back as OUT_OF_MEMORY", async () => {
  const outcome = await runIsolated(MEMORY_HOG, observation("hi"));
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "OUT_OF_MEMORY");
});

// The second wall: whatever runs in the thread, the server ends it. A limit shorter than
// QuickJS's own deadline shows the thread is ended from outside.
test("the server ends an evaluation's thread at its hard limit", async () => {
  const started = Date.now();
  const outcome = await runIsolated(FOREVER, observation("hi"), 300);
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "TIMEOUT");
  assert.ok(Date.now() - started < 1_000, `took ${Date.now() - started} ms`);
});

test("a score of the wrong shape is refused, not passed on to Langfuse", async () => {
  const outcome = await runEvaluator(`function evaluate() { return { scores: [{ name: "x", value: "yes", dataType: "BOOLEAN" }] }; }`, observation("hi"));
  assert.ok("error" in outcome);
  assert.equal(outcome.error.code, "INVALID_RESULT");
  const missing = await runEvaluator(`const x = 1;`, observation("hi"));
  assert.ok("error" in missing);
  assert.equal(missing.error.code, "INVALID_SOURCE");
});

let url = "";
const server = createExecutor(SECRET);
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/evaluate`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

const job = (source: string, input: unknown) =>
  JSON.stringify({
    apiVersion: "v1",
    scope: { organizationId: "workshop", projectId: "hcp-medinfo", evaluatorId: "test" },
    runtime: { language: "TYPESCRIPT" },
    execution: { jobExecutionId: "job-1" },
    code: { source },
    payload: observation(input)
  });

const post = (body: string, signature?: string) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...(signature ? { "x-langfuse-signature": signature } : {}) }, body });

test("a signed job comes back as scores, an unsigned or stale one as 401", async () => {
  const body = job(ALL_CAPS, "STOP");
  const ok = await post(body, sign(SECRET, body));
  assert.equal(ok.status, 200);
  assert.equal(((await ok.json()) as { scores: { value: boolean }[] }).scores[0].value, true);

  assert.equal((await post(body)).status, 401);
  assert.equal((await post(body, sign("another-secret-that-is-also-long-enough-xx", body))).status, 401);
  assert.equal((await post(body, sign(SECRET, body, Math.floor(Date.now() / 1000) - 301))).status, 401);
  assert.equal((await post(job(ALL_CAPS, "changed after signing"), sign(SECRET, body))).status, 401);
});

test("a failed evaluator comes back as 422 with Langfuse's error code", async () => {
  const body = job(FOREVER, "hi");
  const response = await post(body, sign(SECRET, body));
  assert.equal(response.status, 422);
  assert.equal(((await response.json()) as { error: { code: string } }).error.code, "TIMEOUT");
});

// The executor image installs from its own lockfile, so it must pin the same QuickJS as the app.
test("the executor image pins the same QuickJS and amaro as the repo", () => {
  const root = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  const image = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
  assert.deepEqual(image.dependencies, { amaro: root.dependencies.amaro, "quickjs-emscripten": root.dependencies["quickjs-emscripten"] });
});

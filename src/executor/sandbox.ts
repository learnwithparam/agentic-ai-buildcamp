import { transformSync } from "amaro";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
  RELEASE_SYNC,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSHandle
} from "quickjs-emscripten";

// Lesson 12. Runs one Langfuse code evaluator inside QuickJS, a JavaScript engine compiled to
// WebAssembly. The evaluator's code can only reach what this file puts inside the engine, and
// that is its own payload and a console that writes nowhere. There is no process, no require, no
// fetch and no file, because none of those exist in the engine at all.
//
// node:vm, which the insecure-local dispatcher uses, is different: every object passed in is a
// host object, so one line climbs out to the host's process.env. src/executor/executor.test.ts
// shows that with the same planted code this file refuses.

export const LIMITS = {
  // Below Langfuse's 10 second request timeout, so a slow evaluator comes back as TIMEOUT
  // instead of a timeout Langfuse would retry (and run again).
  timeMs: 2_000,
  // Evaluators are small checks on one observation; 64 MB is far more than one needs.
  memoryBytes: 64 * 1024 * 1024,
  stackBytes: 1024 * 1024,
  // The wall under that limit. QuickJS does not count every byte an array asks for, so with
  // memoryBytes alone one evaluator grew the engine's WebAssembly memory past 1 GB before it
  // said "out of memory", and took the container down. WebAssembly memory cannot grow past
  // its maximum, whatever QuickJS counts.
  wasmMemoryBytes: 96 * 1024 * 1024
};

const WASM_PAGE = 64 * 1024;

export type ErrorCode = "USER_CODE_ERROR" | "INVALID_SOURCE" | "INVALID_RESULT" | "TIMEOUT" | "OUT_OF_MEMORY" | "UNSUPPORTED_RUNTIME";
export type Score = {
  name: string;
  value: number | boolean | string;
  dataType: "NUMERIC" | "BOOLEAN" | "CATEGORICAL" | "TEXT";
  comment?: string;
  configId?: string | null;
  metadata?: Record<string, unknown>;
};
export type Outcome = { scores: Score[] } | { error: { code: ErrorCode; message: string } };

const fail = (code: ErrorCode, message: string): Outcome => ({ error: { code, message } });

// A console the evaluator may call. It is plain JavaScript inside the engine, not the host's.
const PRELUDE = `globalThis.console = { log() {}, info() {}, warn() {}, error() {}, debug() {} };`;

type VmError = { name?: string; message?: string };

function classify(error: VmError, deadline: number): Outcome {
  const message = error.message ?? String(error);
  if (error.name === "InternalError" && message === "interrupted") {
    return fail("TIMEOUT", `The evaluator ran longer than ${LIMITS.timeMs / 1000} seconds.`);
  }
  if (/out of memory/i.test(message)) return fail("OUT_OF_MEMORY", `The evaluator used more than ${LIMITS.memoryBytes / 1024 / 1024} MB.`);
  if (Date.now() > deadline) return fail("TIMEOUT", `The evaluator ran longer than ${LIMITS.timeMs / 1000} seconds.`);
  return fail("USER_CODE_ERROR", error.name && error.name !== "Error" ? `${error.name}: ${message}` : message);
}

const DATA_TYPES = new Set(["NUMERIC", "BOOLEAN", "CATEGORICAL", "TEXT"]);
const VALUE_TYPE: Record<string, string> = { NUMERIC: "number", BOOLEAN: "boolean", CATEGORICAL: "string", TEXT: "string" };

// The result crosses back as a JSON string and is checked here, so nothing the evaluator built
// (a getter, a proxy, a huge object) ever runs on the host.
export const MAX_RESULT_BYTES = 256 * 1024;

export function checkResult(json: string): Outcome {
  if (Buffer.byteLength(json) > MAX_RESULT_BYTES) return fail("INVALID_RESULT", "The scores are larger than 256 KB.");
  let result: unknown;
  try {
    result = JSON.parse(json);
  } catch {
    return fail("INVALID_RESULT", "evaluate must return an object with a scores list.");
  }
  const scores = (result as { scores?: unknown })?.scores;
  if (!Array.isArray(scores) || scores.length === 0) return fail("INVALID_RESULT", "evaluate must return at least one score in scores.");
  for (const [index, score] of scores.entries()) {
    const ok =
      score &&
      typeof score === "object" &&
      typeof score.name === "string" &&
      score.name.length > 0 &&
      DATA_TYPES.has(score.dataType) &&
      typeof score.value === VALUE_TYPE[score.dataType] &&
      (score.dataType !== "NUMERIC" || Number.isFinite(score.value)) &&
      (score.comment === undefined || typeof score.comment === "string");
    if (!ok) return fail("INVALID_RESULT", `Score ${index + 1} needs a name, a dataType of NUMERIC, BOOLEAN, CATEGORICAL or TEXT, and a value of that type.`);
  }
  return { scores: scores as Score[] };
}

function dumpError(context: QuickJSContext, handle: QuickJSHandle): VmError {
  const dumped = context.dump(handle);
  return dumped && typeof dumped === "object" ? (dumped as VmError) : { message: String(dumped) };
}

export async function runEvaluator(source: string, payload: unknown): Promise<Outcome> {
  let script: string;
  try {
    // Remove the types, keep the code. amaro is the stripper inside Node itself; Node's own
    // module.stripTypeScriptTypes wraps it but is marked experimental and warns on every process.
    script = transformSync(source, { mode: "strip-only" }).code;
  } catch (error) {
    return fail("INVALID_SOURCE", `The TypeScript could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }

  // A new engine for every evaluation: nothing one evaluator leaves behind is seen by the next.
  const memory = new WebAssembly.Memory({ initial: (16 * 1024 * 1024) / WASM_PAGE, maximum: LIMITS.wasmMemoryBytes / WASM_PAGE });
  const quickjs = await newQuickJSWASMModuleFromVariant(newVariant(RELEASE_SYNC, { wasmMemory: memory }));
  const runtime = quickjs.newRuntime();
  const deadline = Date.now() + LIMITS.timeMs;
  runtime.setMemoryLimit(LIMITS.memoryBytes);
  runtime.setMaxStackSize(LIMITS.stackBytes);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const context = runtime.newContext();
  try {
    const prepared = context.evalCode(`${PRELUDE}\n${script}\n;typeof evaluate === "function"`, "evaluator.js", { type: "global" });
    if (prepared.error) {
      const error = dumpError(context, prepared.error);
      prepared.error.dispose();
      const outcome = classify(error, deadline);
      return "error" in outcome && outcome.error.code === "USER_CODE_ERROR" ? fail("INVALID_SOURCE", outcome.error.message) : outcome;
    }
    const defined = context.dump(prepared.value);
    prepared.value.dispose();
    if (defined !== true) return fail("INVALID_SOURCE", "The evaluator must define a function named evaluate.");

    // The payload goes in as a JSON string and the result comes out as one.
    const input = context.newString(JSON.stringify(payload));
    context.setProp(context.global, "__payload", input);
    input.dispose();
    const started = context.evalCode(
      `(async () => { const ctx = JSON.parse(__payload); delete globalThis.__payload; return JSON.stringify(await evaluate(ctx)); })()`,
      "run.js",
      { type: "global" }
    );
    if (started.error) {
      const error = dumpError(context, started.error);
      started.error.dispose();
      return classify(error, deadline);
    }
    const promise = started.value;
    try {
      // Run the evaluator's promise jobs until it settles. The interrupt handler still stops a loop.
      for (;;) {
        const state = context.getPromiseState(promise);
        if (state.type === "fulfilled") {
          const json = context.dump(state.value);
          state.value.dispose();
          return typeof json === "string" ? checkResult(json) : fail("INVALID_RESULT", "evaluate must return an object with a scores list.");
        }
        if (state.type === "rejected") {
          const error = dumpError(context, state.error);
          state.error.dispose();
          return classify(error, deadline);
        }
        const ran = runtime.executePendingJobs();
        if (ran.error) {
          const error = dumpError(context, ran.error);
          ran.error.dispose();
          return classify(error, deadline);
        }
        // Nothing left to run and still pending: the evaluator awaits something that never comes.
        if (ran.value === 0) return fail("USER_CODE_ERROR", "evaluate returned a promise that never settles.");
      }
    } finally {
      promise.dispose();
    }
  } finally {
    context.dispose();
    runtime.dispose();
  }
}

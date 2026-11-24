import { parentPort, workerData } from "node:worker_threads";
import { runEvaluator } from "./sandbox.ts";

// One evaluation in its own thread. If the engine itself crashes or hangs, only this thread goes,
// never the server, and the server ends any thread still running at its hard limit.
const { source, payload } = workerData as { source: string; payload: unknown };
parentPort?.postMessage(await runEvaluator(source, payload));

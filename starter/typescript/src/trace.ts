// Write employee.trace/v1: one span per line in TRACE_DIR/<run_id>.jsonl. See reference/CONTRACT.md.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export function tracer(runId: string) {
  const dir = process.env.TRACE_DIR ?? "traces";
  mkdirSync(dir, { recursive: true });
  let n = 0;
  return async function span<T>(name: string, parent: string | null, attributes: Record<string, unknown>, fn: (id: string, set: (a: Record<string, unknown>) => void) => Promise<T>): Promise<T> {
    const span_id = `${runId}-${++n}`;
    const start_time = new Date().toISOString();
    const attrs: Record<string, unknown> = { "gen_ai.operation.name": name, ...attributes };
    let status = "ok";
    try { return await fn(span_id, (a) => Object.assign(attrs, a)); } catch (e) { status = "error"; attrs["error.type"] = (e as Error).message; throw e; } finally {
      const line = { format: "employee.trace/v1", trace_id: runId, span_id, parent_span_id: parent, name, start_time, end_time: new Date().toISOString(), status, attributes: attrs };
      appendFileSync(join(dir, `${runId}.jsonl`), JSON.stringify(line) + "\n");
    }
  };
}

// Writes employee.trace/v1: one JSON object per line in <trace dir>/<run_id>.jsonl.
// Names are the OpenTelemetry GenAI names. The x. names cover what OTel has no name for.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export const TRACE_FORMAT = "employee.trace/v1";

export type Span = {
  format: typeof TRACE_FORMAT;
  trace_id: string;
  span_id: string;
  parent_span_id: string | null;
  name: string;
  start_time: string;
  end_time: string;
  status: "ok" | "error";
  attributes: Record<string, string | number | boolean | null>;
};

export function tracer(dir: string, runId: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  let n = 0;
  const spanId = () => `${runId}-${Date.now().toString(36)}-${(++n).toString(36)}`;
  async function span<T>(name: string, parent: string | null, attributes: Span["attributes"], fn: (id: string, set: (a: Span["attributes"]) => void) => Promise<T>): Promise<T> {
    const id = spanId();
    const start = new Date().toISOString();
    const attrs = { "gen_ai.operation.name": name, ...attributes };
    const set = (a: Span["attributes"]) => Object.assign(attrs, a);
    let status: Span["status"] = "ok";
    try { return await fn(id, set); } catch (e) { status = "error"; set({ "error.type": (e as Error).message }); throw e; } finally {
      const line: Span = { format: TRACE_FORMAT, trace_id: runId, span_id: id, parent_span_id: parent, name, start_time: start, end_time: new Date().toISOString(), status, attributes: attrs };
      appendFileSync(file, JSON.stringify(line) + "\n");
    }
  }
  return { file, span };
}

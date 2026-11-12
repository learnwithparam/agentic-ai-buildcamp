// Write employee.trace/v1: one span per line in TRACE_DIR/<run_id>.jsonl.
// See reference/CONTRACT.md.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type Attributes = Record<string, unknown>;
export type AddAttributes = (more: Attributes) => void;

export function tracer(runId: string) {
  const traceDir = process.env.TRACE_DIR ?? "traces";
  mkdirSync(traceDir, { recursive: true });
  let spanCount = 0;

  // Run the work inside one span, and write the span down even when the work throws.
  return async function span<Result>(
    name: string,
    parentId: string | null,
    attributes: Attributes,
    work: (spanId: string, addAttributes: AddAttributes) => Promise<Result>,
  ): Promise<Result> {
    spanCount += 1;
    const spanId = `${runId}-${spanCount}`;
    const startTime = new Date().toISOString();
    const allAttributes: Attributes = { "gen_ai.operation.name": name, ...attributes };
    let status = "ok";
    try {
      return await work(spanId, (more) => Object.assign(allAttributes, more));
    } catch (error) {
      status = "error";
      allAttributes["error.type"] = (error as Error).message;
      throw error;
    } finally {
      const line = {
        format: "employee.trace/v1",
        trace_id: runId,
        span_id: spanId,
        parent_span_id: parentId,
        name,
        start_time: startTime,
        end_time: new Date().toISOString(),
        status,
        attributes: allAttributes,
      };
      appendFileSync(join(traceDir, `${runId}.jsonl`), `${JSON.stringify(line)}\n`);
    }
  };
}

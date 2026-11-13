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

type Attributes = Span["attributes"];
type AddAttributes = (more: Attributes) => void;

export function tracer(dir: string, runId: string) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${runId}.jsonl`);
  let spansStarted = 0;
  const nextSpanId = () => {
    spansStarted += 1;
    return `${runId}-${Date.now().toString(36)}-${spansStarted.toString(36)}`;
  };

  // Runs the work inside one span. The work gets the span's id, to be the parent of inner spans,
  // and a way to add attributes it only learns while it runs, such as the model's token counts.
  async function span<Result>(
    name: string,
    parent: string | null,
    attributes: Attributes,
    work: (id: string, addAttributes: AddAttributes) => Promise<Result>,
  ): Promise<Result> {
    const id = nextSpanId();
    const startTime = new Date().toISOString();
    const allAttributes: Attributes = { "gen_ai.operation.name": name, ...attributes };
    const addAttributes = (more: Attributes) => Object.assign(allAttributes, more);
    let status: Span["status"] = "ok";
    try {
      return await work(id, addAttributes);
    } catch (error) {
      status = "error";
      addAttributes({ "error.type": (error as Error).message });
      throw error;
    } finally {
      const line: Span = {
        format: TRACE_FORMAT,
        trace_id: runId,
        span_id: id,
        parent_span_id: parent,
        name,
        start_time: startTime,
        end_time: new Date().toISOString(),
        status,
        attributes: allAttributes,
      };
      appendFileSync(file, `${JSON.stringify(line)}\n`);
    }
  }

  return { file, span };
}

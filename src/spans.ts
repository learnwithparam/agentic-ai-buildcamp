// Reads spans back from Phoenix, so a check can prove what really ran.
import { PHOENIX_URL, PROJECT } from "../packages/core/src/telemetry";

const SECONDS_TO_WAIT = 20;

export type Span = {
  name: string;
  context: { trace_id: string; span_id: string };
  parent_id: string | null;
  attributes: Record<string, unknown>;
};

// Until the first span arrives, Phoenix sends plain text. So a bad reply means wait.
async function recentSpans(): Promise<Span[]> {
  const reply = await fetch(`${PHOENIX_URL}/v1/projects/${PROJECT}/spans?limit=200`);
  if (!reply.ok) return [];
  const body = (await reply.json().catch(() => ({}))) as { data?: Span[] };
  return body.data ?? [];
}

export async function spansWithRunId(runId: string): Promise<Span[]> {
  for (let attempt = 0; attempt < SECONDS_TO_WAIT; attempt++) {
    const mine = (await recentSpans()).filter((span) => span.attributes.run_id === runId);
    if (mine.length >= 1) return mine;
    await Bun.sleep(1000);
  }
  return [];
}

// The model span has no run_id. Find it by the trace it shares with its parent.
export async function allSpansOfTrace(traceId: string): Promise<Span[]> {
  for (let attempt = 0; attempt < SECONDS_TO_WAIT; attempt++) {
    const found = (await recentSpans()).filter((span) => span.context.trace_id === traceId);
    if (found.length >= 2) return found;
    await Bun.sleep(1000);
  }
  return [];
}

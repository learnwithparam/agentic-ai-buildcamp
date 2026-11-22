// Module 01: one model call leaves one nested trace in Phoenix, with tokens, cost and tags.
import { ask } from "../packages/core/src/ask";
import { flushTraces, traced } from "../packages/core/src/telemetry";
import { allSpansOfTrace, type Span, spansWithRunId } from "../src/spans";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "pharma-a", agentName: "trace-check" };
const PROMPT = "Reply with the single word: ready";

async function oneTracedCall(runId: string): Promise<Span[]> {
  await traced("trace-check", TAGS, async (setAttributes) => {
    setAttributes({ run_id: runId });
    await ask("fast", PROMPT, { ...TAGS });
  });
  await flushTraces();
  return spansWithRunId(runId);
}

export const checks: Check[] = [
  {
    name: "A model call becomes a span inside a parent span",
    tryNext: "In traced, start the span with startActiveSpan so child spans nest inside it.",
    run: async (trial) => {
      const runId = `${Date.now()}-${trial}`;
      const parents = await oneTracedCall(runId);
      expect(parents.length > 0, "Phoenix has no span for this run.");
      const spans = await allSpansOfTrace(parents[0].context.trace_id);
      const model = spans.find((span) => span.name === "llm.fast");
      expect(model !== undefined, "The trace has no llm.fast span.");
      expect(model.parent_id !== null, "The model span is not nested inside a parent.");
    },
  },
  {
    name: "The model span holds tokens and cost",
    tryNext: "In ask, set the token counts and cost_usd on the span.",
    run: async (trial) => {
      const runId = `${Date.now()}-tokens-${trial}`;
      const parents = await oneTracedCall(runId);
      const spans = await allSpansOfTrace(parents[0]?.context.trace_id ?? "");
      const model = spans.find((span) => span.name === "llm.fast");
      expect(model !== undefined, "The trace has no llm.fast span.");
      expect(model.attributes["llm.token_count.prompt"] === 12, "The prompt tokens are missing.");
      expect(Number(model.attributes.cost_usd) > 0, "The span has no cost.");
    },
  },
  {
    name: "Every span carries the tenant and the agent name",
    tryNext: "In traced, set tenant_id and agent_name on every span.",
    run: async (trial) => {
      const runId = `${Date.now()}-tags-${trial}`;
      const parents = await oneTracedCall(runId);
      const spans = await allSpansOfTrace(parents[0]?.context.trace_id ?? "");
      expect(spans.length >= 2, "The trace has fewer than two spans.");
      for (const span of spans) {
        expect(span.attributes.tenant_id === "pharma-a", `${span.name} has no tenant_id.`);
        expect(span.attributes.agent_name === "trace-check", `${span.name} has no agent_name.`);
      }
    },
  },
];

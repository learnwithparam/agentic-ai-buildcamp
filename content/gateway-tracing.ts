import type { UnitContent } from "../src/content";

export const content: UnitContent = {
  opening: "Why did the agent give that answer, and what did it cost?",
  production:
    "Phoenix is the trace store. Finance reads the cost on each span to bill each tenant.",
  terms: [
    {
      id: "span",
      word: "span",
      meaning: "One timed step, such as a single model call. It holds notes about that step.",
    },
    {
      id: "trace",
      word: "trace",
      meaning: "All the spans of one request, in order. Spans nest inside their parent.",
    },
    {
      id: "replay",
      word: "replay",
      meaning: "Playing back a reply that was saved from a real model. It needs no key.",
    },
  ],
  picture: `flowchart LR
  A[Agent] --> S[Parent span]
  S --> L[Model span with tokens and cost]
  S --> P[Phoenix]
  L --> P`,
  stuck: {
    correct: "Three green badges, and a trace with two nested spans in Phoenix.",
    wrong: "The model span shows up alone, outside its parent.",
    hint: "A child span needs a context manager to find its parent.",
    rows: [
      [
        "The model span is not nested inside a parent.",
        "No context manager is registered, so each span starts its own trace.",
        "Register the async context manager before the first span.",
      ],
      [
        "The trace has no llm.fast span.",
        "The model call never made a span.",
        "Wrap the model call in traced inside ask.",
      ],
      [
        "The prompt tokens are missing.",
        "The span has no token counts.",
        "Set the token counts and cost on the span.",
      ],
    ],
  },
  breaks: [
    {
      file: "packages/core/src/telemetry.ts",
      rule: "spans must nest, so a context manager must be registered",
      find: "context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());",
      replace: "",
    },
    {
      file: "packages/core/src/telemetry.ts",
      rule: "every span must carry the tenant",
      find: "      tenant_id: tags.tenantId,\n",
      replace: "",
    },
    {
      file: "packages/core/src/ask.ts",
      rule: "the model span must hold the cost",
      find: "cost_usd: reply.costUsd,",
      replace: "",
    },
  ],
};

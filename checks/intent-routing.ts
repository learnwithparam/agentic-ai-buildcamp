// Module 03: each question picks its path before the agent loop runs.
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { decide, handle } from "../packages/core/src/router";
import { flushTraces, traced } from "../packages/core/src/telemetry";
import { allSpansOfTrace, spansWithRunId } from "../src/spans";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "pharma-a", agentName: "router-check" };

function questionOf(name: string): string {
  const found = HCP_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found.question;
}

async function noModelAnswer(): Promise<never> {
  throw new Error("This path must not call a model.");
}

export const checks: Check[] = [
  {
    name: "Trivia gets a template reply with no model call",
    tryNext: "In decide, send questions that name no brand and no medical topic to template.",
    run: async (trial) => {
      const runId = `${Date.now()}-route-${trial}`;
      const question = questionOf("trivia-template");
      const result = await traced("route-check", TAGS, async (setAttributes) => {
        setAttributes({ run_id: runId });
        return handle(question, TAGS, noModelAnswer);
      });
      expect(result.route === "template", `The route was ${result.route}, wanted template.`);
      await flushTraces();
      const parents = await spansWithRunId(runId);
      const spans = await allSpansOfTrace(parents[0]?.context.trace_id ?? "");
      expect(spans.length >= 2, "The trace has no route span.");
      const models = spans.filter((span) => span.name.startsWith("llm."));
      expect(models.length === 0, "The template path still called a model.");
    },
  },
  {
    name: "An off-label request is refused",
    tryNext: "In decide, refuse a question that asks what a drug works for off the label.",
    run: async () => {
      const decision = decide(questionOf("off-label-refused"));
      expect(decision.route === "refuse", `The route was ${decision.route}, wanted refuse.`);
      expect(decision.reason === "off-label", "The refusal reason is not off-label.");
    },
  },
  {
    name: "A safety report inside a friendly note is escalated",
    tryNext: "In decide, check for safety words before anything else.",
    run: async () => {
      const decision = decide(questionOf("adverse-event-pause"));
      expect(decision.route === "escalate", `The route was ${decision.route}, wanted escalate.`);
    },
  },
  {
    name: "A request to send an approved reply goes to approval",
    tryNext: "In decide, send a request that starts with send the approved to approve.",
    run: async () => {
      const decision = decide(questionOf("safety-approval-resumes"));
      expect(decision.route === "approve", `The route was ${decision.route}, wanted approve.`);
    },
  },
  {
    name: "Every plain medical question still goes to the agent",
    tryNext: "In decide, keep answer as the last path for a question about a brand or a topic.",
    run: async () => {
      for (const item of HCP_GOLDEN.cases.filter((other) => other.intent === "answer")) {
        const decision = decide(item.question);
        expect(decision.route === "answer", `${item.name} went to ${decision.route}, not answer.`);
      }
    },
  },
];

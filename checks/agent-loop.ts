// Module 05: the model picks tools in a loop, and a loop that never ends is stopped.
// Replay has no model to call. A scripted model plays the replies, through the real ai interface.
import { MockLanguageModelV4 } from "ai/test";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { MAX_TURNS, runAgent } from "../packages/core/src/agent";
import { ingestAll, resetDocuments } from "../packages/core/src/ingestion";
import { grade } from "../src/grade";
import { type Check, expect } from "../src/verify";

const TAGS = { tenantId: "pharma-a", agentName: "agent-loop-check" };
const STUDY = "neurocalm-us-study-summary";
const LABEL = "neurocalm-us-label-v1";

type Reply = { call?: { name: string; input: object }; text?: string };

const NO_TOKENS = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

// A model that follows a script. When the script ends, it repeats the last reply.
function scripted(replies: Reply[]) {
  let turn = 0;
  return new MockLanguageModelV4({
    doGenerate: async () => {
      const reply = replies[Math.min(turn, replies.length - 1)];
      turn += 1;
      const content =
        reply.call === undefined
          ? [{ type: "text" as const, text: reply.text ?? "" }]
          : [
              {
                type: "tool-call" as const,
                toolCallId: `call-${turn}`,
                toolName: reply.call.name,
                input: JSON.stringify(reply.call.input),
              },
            ];
      const reason = reply.call === undefined ? "stop" : "tool-calls";
      return {
        content,
        finishReason: { unified: reason, raw: reason },
        usage: NO_TOKENS,
        warnings: [],
      } as never;
    },
  });
}

const THREE_HOPS: Reply[] = [
  { call: { name: "list_documents", input: { brand: "NeuroCalm", country: "US" } } },
  { call: { name: "read_document", input: { slug: STUDY } } },
  { call: { name: "read_document", input: { slug: LABEL } } },
  {
    text: `NeuroCalm users fell asleep 18 minutes faster, against 6 for the sugar pill. [${STUDY}]`,
  },
];

function goldenCase() {
  const found = HCP_GOLDEN.cases.find((item) => item.name === "multi-hop-cited");
  expect(found !== undefined, "The golden set has no case named multi-hop-cited.");
  return found;
}

async function freshStart(): Promise<void> {
  await resetDocuments();
  await ingestAll();
}

export const checks: Check[] = [
  {
    name: "A three-hop question is answered with two or more tool calls",
    tryNext: "Run each tool the model picks, and send its result back to the model.",
    run: async () => {
      await freshStart();
      const golden = goldenCase();
      const result = await runAgent(golden.question, TAGS, scripted(THREE_HOPS));
      const graded = grade(golden, result);
      expect(graded.ok, `The answer failed: ${graded.reasons.join(", ")}.`);
      expect(result.toolCalls.length >= 2, "The trace holds fewer than two tool calls.");
      expect(result.citations.includes(STUDY), "The answer lost its citation.");
    },
  },
  {
    name: "A tool result goes back to the model",
    tryNext: "After a tool runs, add its result to the messages for the next turn.",
    run: async () => {
      await freshStart();
      const model = scripted(THREE_HOPS);
      await runAgent(goldenCase().question, TAGS, model);
      const second = JSON.stringify(model.doGenerateCalls[1].prompt);
      expect(second.includes(STUDY), "The model never saw the list of documents.");
    },
  },
  {
    name: "A tool that never ends stops at MAX_TURNS with a clear message",
    tryNext: "Count each turn, and stop the loop after MAX_TURNS with a message.",
    run: async () => {
      await freshStart();
      const forever: Reply = {
        call: { name: "list_documents", input: { brand: "NeuroCalm", country: "US" } },
      };
      const model = scripted([forever]);
      const result = await runAgent(goldenCase().question, TAGS, model);
      expect(model.doGenerateCalls.length === MAX_TURNS, "The loop did not stop at MAX_TURNS.");
      expect(result.route === "refuse", "A loop that never ends was not refused.");
      expect(result.text.includes("stopped after"), "The stop message is not clear.");
    },
  },
  {
    name: "An answer with a number the agent never read is refused",
    tryNext: "Check the final answer against the documents the agent read.",
    run: async () => {
      await freshStart();
      const invented: Reply = { text: `Users fell asleep 99 minutes faster. [${STUDY}]` };
      const script = [THREE_HOPS[0], THREE_HOPS[1], invented];
      const result = await runAgent(goldenCase().question, TAGS, scripted(script));
      expect(result.route === "refuse", "A number that is not in the document was accepted.");
    },
  },
];

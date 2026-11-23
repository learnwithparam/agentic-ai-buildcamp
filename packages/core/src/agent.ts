// The agent loop. The model picks a tool, code runs it, and the result goes back to the model.
// The loop ends when the model answers, or when MAX_TURNS runs out. A loop must always end.

import { generateText, type LanguageModel, type ModelMessage, tool } from "ai";
import { z } from "zod";
import { languageModel } from "../../../config/models";
import type { AgentResult } from "../../../src/grade";
import { checkClaim } from "./grounded";
import { activeDocuments, type StoredDocument } from "./ingestion";
import { type Tags, traced } from "./telemetry";

export type ToolCall = { name: string; input: unknown };
export type AgentRun = AgentResult & { toolCalls: ToolCall[]; turns: number };

// #region step:agent-loop
export const MAX_TURNS = 6;

const RULES = `Answer from the documents only. Use the tools to find and read them.
End your answer with the id of each document you used, in square brackets.
If the documents do not say, answer with no id.`;

// The tools have a schema and no code. The loop below runs them, so each call is a visible step.
const ListInput = z.object({ brand: z.string(), country: z.string() });
const ReadInput = z.object({ slug: z.string() });

export const agentTools = {
  list_documents: tool({
    description: "List the current documents for one brand in one country.",
    inputSchema: ListInput,
  }),
  read_document: tool({
    description: "Read one listed document by its id.",
    inputSchema: ReadInput,
  }),
};

type Library = { listed: Map<string, StoredDocument>; read: Map<string, StoredDocument> };

async function runTool(call: ToolCall, library: Library, tags: Tags): Promise<string> {
  if (call.name === "list_documents") {
    const { brand, country } = ListInput.parse(call.input);
    const found = await activeDocuments(brand, country, tags.person);
    for (const item of found) library.listed.set(item.slug, item);
    return found.length === 0 ? "No current document." : found.map((item) => item.slug).join("\n");
  }
  const { slug } = ReadInput.parse(call.input);
  const item = library.listed.get(slug);
  if (item === undefined) return `The document ${slug} was not listed. List documents first.`;
  library.read.set(slug, item);
  return `[${item.slug}]\n${item.body}`;
}

function stopped(turns: number, toolCalls: ToolCall[]): AgentRun {
  const text = `The agent stopped after ${MAX_TURNS} turns without an answer.`;
  return { route: "refuse", text, citations: [], toolCalls, turns };
}

export async function runAgent(
  question: string,
  tags: Tags,
  model: LanguageModel,
): Promise<AgentRun> {
  const library: Library = { listed: new Map(), read: new Map() };
  const messages: ModelMessage[] = [{ role: "user", content: question }];
  const toolCalls: ToolCall[] = [];
  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    const step = await traced("agent.turn", tags, async (setAttributes) => {
      const result = await generateText({ model, system: RULES, messages, tools: agentTools });
      setAttributes({ turn, tool_calls: result.toolCalls.length });
      return result;
    });
    messages.push(...step.response.messages);
    if (step.toolCalls.length === 0) return finish(step.text, library, toolCalls, turn);
    const results = [];
    for (const call of step.toolCalls) {
      toolCalls.push({ name: call.toolName, input: call.input });
      const value = await runTool({ name: call.toolName, input: call.input }, library, tags);
      const output = { type: "text" as const, value };
      results.push({
        type: "tool-result" as const,
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        output,
      });
    }
    messages.push({ role: "tool", content: results });
  }
  return stopped(MAX_TURNS, toolCalls);
}

// The answer is a claim. It must cite a document the agent read, and use only its numbers.
function finish(text: string, library: Library, toolCalls: ToolCall[], turns: number): AgentRun {
  const problem = checkClaim(text, [...library.read.values()]);
  if (problem !== undefined) {
    const refusal = `I cannot give that answer: ${problem}.`;
    return { route: "refuse", text: refusal, citations: [], toolCalls, turns };
  }
  const citations = [...text.matchAll(/\[([a-z0-9-]+)\]/g)].map((match) => match[1]);
  return { route: "answer", text, citations, toolCalls, turns };
}
// #stub
//~ // TODO(agent-loop): let the model pick tools, run them, and stop at MAX_TURNS
//~ export const MAX_TURNS = 6;
//~
//~ export async function runAgent(
//~   _question: string,
//~   _tags: Tags,
//~   _model: LanguageModel,
//~ ): Promise<AgentRun> {
//~   return { route: "refuse", text: "Not built yet.", citations: [], toolCalls: [], turns: 0 };
//~ }
// #endregion

// The real agent: the same loop, with the smart model from config/models.ts.
export async function agent(question: string): Promise<AgentRun> {
  const tags = { tenantId: "pharma-a", agentName: "agent-loop" };
  return runAgent(question, tags, await languageModel("smart"));
}

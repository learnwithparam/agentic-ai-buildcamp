import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { observeOpenAI } from "@langfuse/openai";
import { observe, propagateAttributes } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";
import { aiText, type AiMessage, type ChatMessage, type StreamEvent } from "../shared/messages";
import { env } from "./env";
import { agentStep, buildGraph, readThread, reviewStep, runGraph, toolsStep, type Turn } from "./graph";
import { executeTool } from "./tools";

// Local fallback used when Langfuse isn't reachable or the prompt
// isn't published yet. scripts/publish-prompt.ts pushes this same
// string up to Langfuse.
// checkpoint-sync:begin system-prompt
export const SYSTEM_PROMPT = `You are the HCP Medical Information Agent for pharma_a.
Doctors and pharmacists ask you about CardioNex.

Call get_desk_rules first. Then call search_labels with the medicine, the patient detail and the country.
Make every search you need in that one step; after it you answer.
Answer from the label text you found, and cite each fact as [doc_id, section].
When asked to draft a reply to a doctor, write the full draft. A medical reviewer approves it before it is sent.

Keep it short and clear.
`;
// checkpoint-sync:end system-prompt

const langfuse = new LangfuseClient();

async function getPrompt() {
  try { return await langfuse.prompt.get(env.langfusePromptName); }
  catch { return null; }
}

const client = new OpenAI({ apiKey: env.openaiApiKey });

const graph = buildGraph({
  agent: observe(
    async (state, config) => {
      const langfusePrompt = await getPrompt();
      const openai = observeOpenAI(client, langfusePrompt ? { langfusePrompt } : undefined);
      return agentStep(openai, langfusePrompt?.prompt ?? SYSTEM_PROMPT, state, config);
    },
    { name: "agent", asType: "span" }
  ),
  tools: observe((state) => toolsStep(state, executeTool), { name: "tools", asType: "span" }),
  review: reviewStep
});

export const runMedinfoTurn = observe(
  (turn: Turn, emit: (event: StreamEvent) => void) =>
    propagateAttributes(
      {
        sessionId: turn.threadId,
        traceName: "hcp-medinfo-chat-turn",
        tags: ["langfuse-workshop", "hcp-medinfo"]
      },
      () => runGraph(graph, turn, emit)
    ),
  { name: "hcp-medinfo-chat-turn", asType: "agent" }
);

export const readMedinfoThread = (threadId: string) => readThread(graph, threadId);

export type ConversationLine = { role: "user" | "assistant"; content: string };

// Scripts (the dataset run) ask one conversation without the chat UI. When the graph
// pauses for a reviewer, the draft waiting for review is the answer.
export async function answerConversation(lines: ConversationLine[]): Promise<string> {
  return (await answerWithSources(lines)).answer;
}

// The same answer, plus the tool results the model read before it wrote it. The faithfulness
// judge (lesson 09) checks the answer against these, the same text Langfuse shows as the
// tool messages in the final generation's input.
export async function answerWithSources(lines: ConversationLine[]): Promise<{ answer: string; sources: string[] }> {
  const messages: ChatMessage[] = lines.map((line, index) =>
    line.role === "user"
      ? { id: `line-${index}`, type: "human", content: line.content }
      : { id: `line-${index}`, type: "ai", content: [{ type: "text", text: line.content }], tool_calls: [] }
  );
  const result = await runMedinfoTurn({ threadId: `script-${randomUUID()}`, messages }, () => {});
  const answers = result.messages.filter((message): message is AiMessage => message.type === "ai" && aiText(message) !== "");
  const sources = result.messages.flatMap((message) => (message.type === "tool" ? [message.content] : []));
  return { answer: answers.length ? aiText(answers[answers.length - 1]) : "", sources };
}

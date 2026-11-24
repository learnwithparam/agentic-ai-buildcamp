import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { aiText, type AiMessage, type ChatMessage, type StreamEvent } from "../shared/messages";
import { env } from "./env";
import { agentStep, buildGraph, readThread, reviewStep, runGraph, toolsStep, type Turn } from "./graph";
import { executeTool } from "./tools";

// The agent's instructions. Lesson 03 moves them into Langfuse and keeps this as the fallback.
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

const openai = new OpenAI({ apiKey: env.openaiApiKey });

// The graph: the agent node calls tools until it has the label text, then answers.
// A drafted reply pauses at the review node until a medical reviewer decides.
const graph = buildGraph({
  agent: (state, config) => agentStep(openai, SYSTEM_PROMPT, state, config),
  tools: (state) => toolsStep(state, executeTool),
  review: reviewStep
});

export const runMedinfoTurn = (turn: Turn, emit: (event: StreamEvent) => void) => runGraph(graph, turn, emit);

export const readMedinfoThread = (threadId: string) => readThread(graph, threadId);

export type ConversationLine = { role: "user" | "assistant"; content: string };

// Scripts (the dataset run) ask one conversation without the chat UI. When the graph
// pauses for a reviewer, the draft waiting for review is the answer.
export async function answerConversation(lines: ConversationLine[]): Promise<string> {
  const messages: ChatMessage[] = lines.map((line, index) =>
    line.role === "user"
      ? { id: `line-${index}`, type: "human", content: line.content }
      : { id: `line-${index}`, type: "ai", content: [{ type: "text", text: line.content }], tool_calls: [] }
  );
  const result = await runMedinfoTurn({ threadId: `script-${randomUUID()}`, messages }, () => {});
  const answers = result.messages.filter((message): message is AiMessage => message.type === "ai" && aiText(message) !== "");
  return answers.length ? aiText(answers[answers.length - 1]) : "";
}

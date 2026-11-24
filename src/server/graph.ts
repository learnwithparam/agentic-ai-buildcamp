import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { Annotation, Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { LangGraphRunnableConfig } from "@langchain/langgraph";
import {
  aiText,
  type AiMessage,
  type ApprovalDecision,
  type ApprovalRequest,
  type ChatMessage,
  type HumanMessage,
  type StreamEvent,
  type ToolMessage
} from "../shared/messages";
import { env } from "./env";
import { streamModelTurn, toOpenAIMessages } from "./stream-model";
import { TOOL_DEFINITIONS } from "./tools";

// The agent graph: agent -> tools -> agent ... -> review -> end.
// The agent node calls the model, the tools node runs what it asked for. Once the labels
// are found, the agent answers with tools switched off. The
// review node pauses a drafted reply until a human approves it.

function mergeById(current: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const merged = [...current];
  for (const message of incoming) {
    const at = merged.findIndex((existing) => existing.id === message.id);
    if (at === -1) merged.push(message);
    else merged[at] = message;
  }
  return merged;
}

export const State = Annotation.Root({
  messages: Annotation<ChatMessage[]>({ reducer: mergeById, default: () => [] })
});
type GraphState = typeof State.State;
type NodeResult = Promise<Partial<GraphState>> | Partial<GraphState>;
type Node = (state: GraphState, config: LangGraphRunnableConfig) => NodeResult;

const MAX_TOOL_ROUNDS = 5;

function lastHuman(state: GraphState): HumanMessage | undefined {
  return [...state.messages].reverse().find((message): message is HumanMessage => message.type === "human");
}

function last<T extends ChatMessage["type"]>(state: GraphState, type: T) {
  const message = state.messages.at(-1);
  return message?.type === type ? (message as Extract<ChatMessage, { type: T }>) : undefined;
}

export async function agentStep(
  openai: OpenAI,
  system: string,
  state: GraphState,
  config: LangGraphRunnableConfig
): Promise<Partial<GraphState>> {
  const sinceQuestion = state.messages.slice(state.messages.lastIndexOf(lastHuman(state)!));
  const rounds = sinceQuestion.filter((message) => message.type === "ai").length;
  // Gather first (desk rules, label searches), then answer with tools off.
  const searched = sinceQuestion.some((message) => message.type === "tool" && message.name === "search_labels");
  const reply = await streamModelTurn(
    openai,
    {
      model: env.openaiModel,
      messages: toOpenAIMessages(system, state.messages),
      tools: TOOL_DEFINITIONS,
      allowTools: !searched && rounds < MAX_TOOL_ROUNDS
    },
    (partial) => config.writer?.(partial)
  );
  return { messages: [reply] };
}

export async function toolsStep(
  state: GraphState,
  runTool: (name: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>
): Promise<Partial<GraphState>> {
  const request = last(state, "ai");
  const results: ToolMessage[] = [];
  for (const call of request?.tool_calls ?? []) {
    const result = await runTool(call.name, call.args);
    results.push({
      id: `tool-${call.id}`,
      type: "tool",
      tool_call_id: call.id,
      name: call.name,
      content: JSON.stringify(result),
      status: result.ok === false ? "error" : "success"
    });
  }
  return { messages: results };
}

// checkpoint-sync:begin review-rule
// A request to draft a reply to a doctor always waits for a human reviewer.
const DRAFT_REQUEST = /\b(draft|write)\b[\s\S]*\b(reply|email|letter|response|answer)\b/i;
// checkpoint-sync:end review-rule

export function reviewStep(state: GraphState): Partial<GraphState> {
  const question = lastHuman(state)?.content ?? "";
  const answer = last(state, "ai");
  if (!answer || !DRAFT_REQUEST.test(question)) return {};

  const decision = interrupt<ApprovalRequest, ApprovalDecision>({
    kind: "approval",
    question,
    draft: aiText(answer)
  });
  const note: AiMessage = {
    id: `review-${randomUUID()}`,
    type: "ai",
    content: [
      {
        type: "text",
        text:
          decision === "approve"
            ? "A reviewer approved this draft. It is ready to send."
            : "A reviewer rejected this draft. Nothing was sent."
      }
    ],
    tool_calls: []
  };
  return { messages: [note] };
}

export function buildGraph(nodes: { agent: Node; tools: Node; review: Node }) {
  return new StateGraph(State)
    .addNode("agent", nodes.agent)
    .addNode("tools", nodes.tools)
    .addNode("review", nodes.review)
    .addEdge(START, "agent")
    .addConditionalEdges("agent", (state) => (last(state, "ai")?.tool_calls.length ? "tools" : "review"), [
      "tools",
      "review"
    ])
    .addEdge("tools", "agent")
    .addEdge("review", END)
    .compile({ checkpointer: new MemorySaver() });
}

type Graph = ReturnType<typeof buildGraph>;

export type Turn = {
  threadId: string;
  messages?: ChatMessage[];
  resume?: ApprovalDecision;
};

export type TurnResult = { messages: ChatMessage[]; waitingForApproval: boolean };

// Runs one turn and translates LangGraph's stream into the events the chat UI reads:
// messages/partial while the model types, updates (with any pause), and values at the end.
export async function runGraph(graph: Graph, turn: Turn, emit: (event: StreamEvent) => void): Promise<TurnResult> {
  // A resume carries the reviewer's decision back to the paused review node.
  const input = turn.resume
    ? (new Command({ resume: turn.resume }) as unknown as Parameters<Graph["stream"]>[0])
    : { messages: turn.messages ?? [] };
  const stream = await graph.stream(input, {
    configurable: { thread_id: turn.threadId },
    streamMode: ["custom", "updates", "values"]
  });
  let messages: ChatMessage[] = [];
  let waitingForApproval = false;
  for await (const [mode, chunk] of stream) {
    if (mode === "custom") {
      emit({ event: "messages/partial", data: [chunk] });
    } else if (mode === "updates") {
      const pause = (chunk as { __interrupt__?: Array<{ id?: string; value: unknown }> }).__interrupt__;
      waitingForApproval = Boolean(pause?.length);
      emit({
        event: "updates",
        data: pause ? { __interrupt__: pause.map((item) => ({ id: item.id, value: item.value, resumable: true })) } : chunk
      });
    } else if (mode === "values") {
      // When the graph pauses, LangGraph sends a values chunk that holds only __interrupt__.
      messages = (chunk as Partial<GraphState>).messages ?? messages;
      emit({ event: "values", data: chunk });
    }
  }
  return { messages, waitingForApproval };
}

export async function readThread(graph: Graph, threadId: string) {
  const state = await graph.getState({ configurable: { thread_id: threadId } });
  return {
    messages: ((state.values as Partial<GraphState>).messages ?? []) as ChatMessage[],
    interrupts: state.tasks.flatMap((task) =>
      task.interrupts.map((item) => ({ id: item.id, value: item.value, resumable: true }))
    )
  };
}

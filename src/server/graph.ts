import type { ReviewStatus } from "./reviews";
import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { Annotation, Command, END, START, StateGraph, interrupt } from "@langchain/langgraph";
import type { BaseCheckpointSaver } from "@langchain/langgraph";
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
import type { Identity } from "./users";
import type { Route } from "./tiers";
import { TODAY, TOOL_DEFINITIONS } from "./tools";

// The agent graph. The router sorts the question into a risk tier (lesson 13, see buildGraph).
// The agent node calls the model, the tools node runs what it asked for. Once the labels
// are found, the agent answers with tools switched off. A draft waits for a medical reviewer.

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
  messages: Annotation<ChatMessage[]>({ reducer: mergeById, default: () => [] }),
  // Lesson 13: the tier the router chose for the latest question, and when its reviewer is due.
  route: Annotation<Route | null>({ reducer: (_current, next) => next, default: () => null }),
  dueAt: Annotation<string | null>({ reducer: (_current, next) => next, default: () => null }),
  // Lesson 16: the day this turn answers for. A chat is today; an event can name its own day.
  today: Annotation<string>({ reducer: (_current, next) => next, default: () => TODAY })
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

export function userOf(config: LangGraphRunnableConfig): Identity {
  const user = config.configurable?.user as Identity | undefined;
  if (!user) throw new Error("A graph run needs the signed-in user in its config.");
  return user;
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

// Lesson 13. What the review tier hands a human, and how the graph waits for them. The inbox is
// passed in the run config: the web app gives the Postgres one, and scripts (the dataset run)
// give none, so a throwaway thread writes no inbox row.
export type ReviewSubmission = {
  id: string;
  // Lesson 14 adds a flagged email (for a medical reviewer) and an outreach step (for a sales rep).
  kind: "draft" | "adverse_event" | "email" | "outreach";
  threadId: string;
  tenantId: string;
  traceId?: string;
  question: string;
  body: string;
};
export interface ReviewInbox {
  // Must be safe to call twice with the same id: a node runs again when its thread resumes.
  // It returns the item's status: one already decided stays decided.
  submit(item: ReviewSubmission): Promise<{ dueAt: Date; status: ReviewStatus }>;
}

export function inboxOf(config: LangGraphRunnableConfig): ReviewInbox | undefined {
  return config.configurable?.inbox as ReviewInbox | undefined;
}

function threadIdOf(config: LangGraphRunnableConfig): string {
  return String(config.configurable?.thread_id ?? "");
}

export const REVIEW_STAMP = "REVIEW_REQUIRED";

// The draft is stamped in code, so the doctor and the reviewer see the same marker whatever the
// model wrote, and it goes into the inbox before the graph waits.
export async function submitDraftStep(state: GraphState, config: LangGraphRunnableConfig, traceId?: string): Promise<Partial<GraphState>> {
  const answer = last(state, "ai");
  const question = lastHuman(state)?.content ?? "";
  if (!answer) return {};
  const text = aiText(answer);
  const stamped = text.startsWith(REVIEW_STAMP) ? text : `${REVIEW_STAMP}\n\n${text}`;
  const user = userOf(config);
  const submitted = await inboxOf(config)?.submit({
    id: `draft-${threadIdOf(config)}-${answer.id}`,
    kind: "draft",
    threadId: threadIdOf(config),
    tenantId: user.tenantId,
    traceId,
    question,
    body: stamped
  });
  const message: AiMessage = { ...answer, content: [{ type: "text", text: stamped }] };
  return { messages: [message], dueAt: submitted?.dueAt.toISOString() ?? null };
}

export function reviewStep(state: GraphState, config: LangGraphRunnableConfig): Partial<GraphState> {
  const answer = last(state, "ai");
  if (!answer) return {};
  const itemId = `draft-${threadIdOf(config)}-${answer.id}`;
  const decision = interrupt<ApprovalRequest, ApprovalDecision>({
    kind: "approval",
    itemId,
    question: lastHuman(state)?.content ?? "",
    draft: aiText(answer),
    dueAt: state.dueAt ?? ""
  });
  // A decision made for another draft never releases this one.
  if (decision.itemId !== itemId) throw new Error(`The decision is for ${decision.itemId}, not for ${itemId}.`);
  const note: AiMessage = {
    id: `review-${answer.id}`,
    type: "ai",
    content: [
      {
        type: "text",
        text:
          decision.decision === "approve"
            ? "A medical reviewer approved this draft. It is ready to send."
            : "A medical reviewer rejected this draft. Nothing was sent."
      }
    ],
    tool_calls: []
  };
  return { messages: [note] };
}

// The safety and stop tiers reply with fixed text and never call the agent.
export function fixedReply(state: GraphState, text: string): Partial<GraphState> {
  const question = lastHuman(state);
  return { messages: [{ id: `reply-${question?.id ?? randomUUID()}`, type: "ai", content: [{ type: "text", text }], tool_calls: [] }] };
}

// The report holds the doctor's (scrubbed) words and the fixed reply the desk gave them.
export async function submitAdverseEvent(state: GraphState, config: LangGraphRunnableConfig, reply: string, traceId?: string) {
  const question = lastHuman(state);
  const user = userOf(config);
  return inboxOf(config)?.submit({
    id: `ae-${threadIdOf(config)}-${question?.id ?? randomUUID()}`,
    kind: "adverse_event",
    threadId: threadIdOf(config),
    tenantId: user.tenantId,
    traceId,
    question: question?.content ?? "",
    body: reply
  });
}

type Nodes = { router: Node; agent: Node; tools: Node; submit: Node; review: Node; safety: Node; stop: Node };

// START -> router -> answer: agent <-> tools -> END
//                 -> review: agent <-> tools -> submit -> review (waits for a human) -> END
//                 -> safety: fixed reply, report to the safety inbox -> END
//                 -> stop:   fixed refusal -> END
// The router may also answer itself (the lesson 10 out-of-scope door), and then the turn ends.
export function buildGraph(nodes: Nodes, checkpointer: BaseCheckpointSaver) {
  return new StateGraph(State)
    .addNode("router", nodes.router)
    .addNode("agent", nodes.agent)
    .addNode("tools", nodes.tools)
    .addNode("submit", nodes.submit)
    .addNode("review", nodes.review)
    .addNode("safety", nodes.safety)
    .addNode("stop", nodes.stop)
    .addEdge(START, "router")
    .addConditionalEdges(
      "router",
      (state) => {
        if (last(state, "ai")) return END;
        // No tier means the router failed: stop the turn rather than guess the safest-looking path.
        if (!state.route) throw new Error("The router chose no tier.");
        const { tier } = state.route;
        return tier === "safety" ? "safety" : tier === "stop" ? "stop" : "agent";
      },
      ["agent", "safety", "stop", END]
    )
    .addConditionalEdges(
      "agent",
      (state) => (last(state, "ai")?.tool_calls.length ? "tools" : state.route?.tier === "review" ? "submit" : END),
      ["tools", "submit", END]
    )
    .addEdge("tools", "agent")
    .addEdge("submit", "review")
    .addEdge("review", END)
    .addEdge("safety", END)
    .addEdge("stop", END)
    .compile({ checkpointer });
}

type Graph = ReturnType<typeof buildGraph>;

export type Turn = {
  threadId: string;
  // Lesson 13: where review items go. Left out by scripts, whose threads are thrown away.
  inbox?: ReviewInbox;
  // Lesson 11: who is asking, from the signed-in user's token. Tools read it from the run config.
  user: Identity;
  messages?: ChatMessage[];
  resume?: ApprovalDecision;
  // Lesson 16: the day the labels are read for, when an event names one.
  today?: string;
};

// route is the tier this turn took (null when the input check refused before any routing).
export type TurnResult = { messages: ChatMessage[]; waitingForApproval: boolean; route: Route | null };

// Runs one turn and translates LangGraph's stream into the events the chat UI reads:
// messages/partial while the model types, updates (with any pause), and values at the end.
export async function runGraph(graph: Graph, turn: Turn, emit: (event: StreamEvent) => void): Promise<TurnResult> {
  // A resume carries the reviewer's decision back to the paused review node.
  const input: Parameters<Graph["stream"]>[0] = turn.resume
    ? (new Command({ resume: turn.resume }) as unknown as Parameters<Graph["stream"]>[0])
    : // A new question starts with no tier and no deadline from the last one.
      { messages: turn.messages ?? [], route: null, dueAt: null, today: turn.today ?? TODAY };
  const stream = await graph.stream(input, {
    configurable: { thread_id: turn.threadId, user: turn.user, inbox: turn.inbox },
    streamMode: ["custom", "updates", "values"]
  });
  let messages: ChatMessage[] = [];
  let waitingForApproval = false;
  let route: Route | null = null;
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
      route = (chunk as Partial<GraphState>).route ?? route;
      emit({ event: "values", data: chunk });
    }
  }
  return { messages, waitingForApproval, route };
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

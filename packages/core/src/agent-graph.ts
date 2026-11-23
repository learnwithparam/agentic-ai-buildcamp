// The same three-hop agent, drawn as a graph. Every step is saved in Postgres under a thread id.
// If the server dies, a new process picks up that thread at the last saved step.
import { DOCUMENTS } from "../../../data/catalog/documents";

export type Tool = "find_study" | "read_document";
export type Step = { tool: Tool; input: string } | { answer: string };
export type Entry = { who: "user" | "model" | "tool"; text: string };
export type Decide = (trail: Entry[]) => Promise<Step>;
export type AgentRun =
  | { status: "done"; answer: string; trail: Entry[] }
  | { status: "stopped"; trail: Entry[] };

// Each model hop, tool call and return trip counts as one step. Three hops need seven.
export const RECURSION_LIMIT = 10;

export function runTool(tool: Tool, input: string): string {
  if (tool === "find_study") {
    const found = DOCUMENTS.find((item) => item.brand === input && item.type === "two-column");
    return found?.slug ?? "no study found";
  }
  return DOCUMENTS.find((item) => item.slug === input)?.body ?? "no such document";
}

import {
  Annotation,
  type BaseCheckpointSaver,
  END,
  GraphRecursionError,
  START,
  StateGraph,
} from "@langchain/langgraph";
// #region step:langgraph-agent
import { PostgresSaver } from "@langchain/langgraph-checkpoint-postgres";
import { generateText } from "ai";
import { languageModel } from "../../../config/models";
import { DATABASE_URL } from "./db";

const State = Annotation.Root({
  trail: Annotation<Entry[]>({ reducer: (old, added) => old.concat(added), default: () => [] }),
  next: Annotation<Step | undefined>(),
});

const RULES = `You answer from tools. Reply with one JSON line.
To use a tool: {"tool":"find_study","input":"<brand>"} or {"tool":"read_document","input":"<id>"}.
To finish: {"answer":"<text that ends with the document id in square brackets>"}.`;

export function modelDecide(): Decide {
  return async (trail) => {
    const model = await languageModel("smart");
    const lines = trail.map((entry) => `${entry.who}: ${entry.text}`).join("\n");
    const reply = await generateText({ model, prompt: `${RULES}\n\n${lines}` });
    return JSON.parse(reply.text) as Step;
  };
}

export function buildAgentGraph(checkpointer: BaseCheckpointSaver | undefined, decide: Decide) {
  return new StateGraph(State)
    .addNode("think", async (state) => {
      const step = await decide(state.trail);
      const text = "answer" in step ? step.answer : `${step.tool} ${step.input}`;
      return { trail: [{ who: "model" as const, text }], next: step };
    })
    .addNode("act", (state) => {
      const step = state.next;
      if (step === undefined || "answer" in step) return {};
      return { trail: [{ who: "tool" as const, text: runTool(step.tool, step.input) }] };
    })
    .addEdge(START, "think")
    .addConditionalEdges("think", (state) => (state.next && "tool" in state.next ? "act" : END))
    .addEdge("act", "think")
    .compile({ checkpointer });
}

export type AgentGraph = ReturnType<typeof buildAgentGraph>;

export async function openCheckpointer(): Promise<PostgresSaver> {
  const saver = PostgresSaver.fromConnString(DATABASE_URL);
  await saver.setup();
  return saver;
}

function finish(trail: Entry[], last: Step | undefined): AgentRun {
  if (last && "answer" in last) return { status: "done", answer: last.answer, trail };
  return { status: "stopped", trail };
}

async function drive(graph: AgentGraph, input: object | null, threadId: string) {
  // Sync means each step is in Postgres before the next one starts, so a kill loses nothing.
  const config = {
    configurable: { thread_id: threadId },
    recursionLimit: RECURSION_LIMIT,
    durability: "sync" as const,
  };
  try {
    const state = await graph.invoke(input, config);
    return finish(state.trail, state.next);
  } catch (error) {
    if (!(error instanceof GraphRecursionError)) throw error;
    const saved = await graph.getState(config);
    return finish(saved.values.trail ?? [], undefined);
  }
}

export function runAgent(graph: AgentGraph, question: string, threadId: string) {
  return drive(graph, { trail: [{ who: "user", text: question }] }, threadId);
}

// Passing null means: do not start over, carry on from the last saved step of this thread.
export function resumeAgent(graph: AgentGraph, threadId: string) {
  return drive(graph, null, threadId);
}
// #stub
//~ // TODO(langgraph-agent): build the graph with a Postgres checkpointer and a recursion limit
//~ export type AgentGraph = { thread: string };
//~
//~ export function modelDecide(): Decide {
//~   return async () => ({ answer: "not built yet" });
//~ }
//~
//~ export function buildAgentGraph(_checkpointer: unknown, _decide: Decide): AgentGraph {
//~   return { thread: "none" };
//~ }
//~
//~ export async function openCheckpointer(): Promise<{ end: () => Promise<void> }> {
//~   return { end: async () => {} };
//~ }
//~
//~ export async function runAgent(_graph: AgentGraph, _question: string, _threadId: string) {
//~   return { status: "stopped", trail: [] } as AgentRun;
//~ }
//~
//~ export async function resumeAgent(_graph: AgentGraph, _threadId: string) {
//~   return { status: "stopped", trail: [] } as AgentRun;
//~ }
// #endregion

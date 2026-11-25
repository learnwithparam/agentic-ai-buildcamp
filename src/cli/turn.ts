import { aiText, type AiMessage, type ApprovalRequest, type ChatMessage, type StreamEvent } from "../shared/messages";

// Lesson 19. What one question looks like in the terminal, worked out from the same events the
// chat page reads (src/server/graph.ts runGraph): messages/partial while the agent writes,
// updates when the graph pauses for a reviewer, and values with the whole thread at the end.
// A pure function of the events, so the test replays recorded events with no server.

export type TurnView = {
  text: string;
  // What the agent is doing while it has no text yet, in words a doctor reads.
  activity: string | null;
  waiting: ApprovalRequest | null;
  done: boolean;
};

export const START: TurnView = { text: "", activity: "Reading your question", waiting: null, done: false };

const TOOL_WORDS: Record<string, string> = {
  get_desk_rules: "Reading the desk rules",
  search_labels: "Searching the labels"
};

// The answer to this question: the last reply after the last question in the thread.
export function lastReply(messages: ChatMessage[]): string {
  const asked = messages.map((message) => message.type).lastIndexOf("human");
  const replies = messages.slice(asked + 1).filter((message): message is AiMessage => message.type === "ai" && aiText(message) !== "");
  return replies.length ? aiText(replies[replies.length - 1]) : "";
}

export function applyEvent(view: TurnView, { event, data }: StreamEvent): TurnView {
  if (event === "messages/partial") {
    const message = (data as AiMessage[])[0];
    if (!message || message.type !== "ai") return view;
    const text = aiText(message);
    const tool = message.tool_calls.at(-1)?.name;
    if (text) return { ...view, text, activity: null };
    return { ...view, activity: tool ? (TOOL_WORDS[tool] ?? "Looking it up") : "Writing the answer" };
  }
  if (event === "updates") {
    const pause = (data as { __interrupt__?: Array<{ value: unknown }> }).__interrupt__?.[0]?.value as ApprovalRequest | undefined;
    return pause?.kind === "approval" ? { ...view, waiting: pause, activity: null } : view;
  }
  if (event === "values") {
    const messages = (data as { messages?: ChatMessage[] }).messages;
    return messages ? { ...view, text: lastReply(messages) || view.text, activity: null } : view;
  }
  return view;
}

export async function runTurn(events: AsyncIterable<StreamEvent>, onView: (view: TurnView) => void): Promise<TurnView> {
  let view = START;
  onView(view);
  for await (const event of events) {
    view = applyEvent(view, event);
    onView(view);
  }
  view = { ...view, done: true, activity: null };
  onView(view);
  return view;
}

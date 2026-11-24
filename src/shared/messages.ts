// The message shapes the server streams and the assistant-ui LangGraph runtime reads.
// They follow LangChain's serialized messages, so the UI needs no adapter.

export type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export type AiContent = Array<{ type: "reasoning"; reasoning: string } | { type: "text"; text: string }>;

export type HumanMessage = { id: string; type: "human"; content: string };
export type AiMessage = { id: string; type: "ai"; content: AiContent; tool_calls: ToolCall[] };
export type ToolMessage = {
  id: string;
  type: "tool";
  tool_call_id: string;
  name: string;
  content: string;
  status: "success" | "error";
};

export type ChatMessage = HumanMessage | AiMessage | ToolMessage;

// What the graph sends when it pauses for a reviewer.
// Lesson 13: the doctor's page only shows it; the reviewer decides it from the inbox.
export type ApprovalRequest = { kind: "approval"; itemId: string; draft: string; question: string; dueAt: string };
// A reviewer's decision names the draft it is about, so it can never resume a different one.
export type ApprovalDecision = { itemId: string; decision: "approve" | "reject" };

export type StreamEvent = { event: string; data: unknown };

export function aiText(message: AiMessage): string {
  return message.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("")
    .trim();
}

import type OpenAI from "openai";
import { randomUUID } from "node:crypto";
import type { AiMessage, ChatMessage, ToolCall } from "../shared/messages";

type ChatParams = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export function toOpenAIMessages(system: string, messages: ChatMessage[]): ChatParams[] {
  return [
    { role: "system", content: system },
    ...messages.map((message): ChatParams => {
      if (message.type === "human") return { role: "user", content: message.content };
      if (message.type === "tool") {
        return { role: "tool", tool_call_id: message.tool_call_id, content: message.content };
      }
      const text = message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
      return {
        role: "assistant",
        content: text || null,
        ...(message.tool_calls.length > 0 && {
          tool_calls: message.tool_calls.map((call) => ({
            id: call.id,
            type: "function" as const,
            function: { name: call.name, arguments: JSON.stringify(call.args) }
          }))
        })
      };
    })
  ];
}

function parseArgs(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text || "{}");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function snapshot(id: string, reasoning: string, text: string, calls: Map<number, { id: string; name: string; args: string }>): AiMessage {
  const toolCalls: ToolCall[] = [...calls.values()].map((call) => ({
    id: call.id,
    name: call.name,
    args: parseArgs(call.args)
  }));
  return {
    id,
    type: "ai",
    content: [
      ...(reasoning ? [{ type: "reasoning" as const, reasoning }] : []),
      ...(text ? [{ type: "text" as const, text }] : [])
    ],
    tool_calls: toolCalls
  };
}

// One streamed model call. Every chunk updates the same assistant message, and
// onPartial sends it to the browser so the reply and the thinking appear as they arrive.
export async function streamModelTurn(
  openai: OpenAI,
  request: {
    model: string;
    messages: ChatParams[];
    tools: OpenAI.Chat.Completions.ChatCompletionTool[];
    allowTools: boolean;
  },
  onPartial: (message: AiMessage) => void
): Promise<AiMessage> {
  const id = `ai-${randomUUID()}`;
  let reasoning = "";
  let text = "";
  const calls = new Map<number, { id: string; name: string; args: string }>();

  const stream = await openai.chat.completions.create({
    model: request.model,
    messages: request.messages,
    // The answer turn leaves the tools out: with tools listed, the model sends no thinking.
    ...(request.allowTools ? { tools: request.tools, tool_choice: "auto" as const } : {}),
    stream: true,
    stream_options: { include_usage: true },
    // OpenRouter: ask for a summary of the model's thinking. The model sends one only on a
    // turn without tools, and reliably only at high effort, so the answer turn thinks hard.
    ...({ reasoning: { effort: request.allowTools ? "low" : "high", summary: "auto" } } as object)
  });

  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta as
      | (OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
          reasoning?: string | null;
          reasoning_details?: Array<{ type?: string; text?: string; summary?: string }>;
        })
      | undefined;
    if (!delta) continue;
    // OpenRouter sends thinking as plain text (delta.reasoning) or, for OpenAI
    // models, as summary blocks (delta.reasoning_details). Never both for one chunk.
    const details = (delta.reasoning_details ?? []).map((detail) => detail.summary ?? detail.text ?? "").join("");
    reasoning += details || delta.reasoning || "";
    if (delta.content) text += delta.content;
    for (const call of delta.tool_calls ?? []) {
      const current = calls.get(call.index) ?? { id: call.id ?? `call-${randomUUID()}`, name: "", args: "" };
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.args += call.function.arguments;
      calls.set(call.index, current);
    }
    onPartial(snapshot(id, reasoning, text, calls));
  }

  return snapshot(id, reasoning, text, calls);
}

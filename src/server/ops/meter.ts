import { AsyncLocalStorage } from "node:async_hooks";

// What one turn cost and how it went, read from the model calls it made. The gateway's fetch
// (src/server/gateway.ts) reports each response here while a turn runs; outside a turn it does
// nothing. Cost is the gateway's own number (usage.cost), never a price table kept in this repo.
export type TurnMetrics = {
  seconds: number;
  calls: number;
  costUsd: number;
  // Calls whose answer had no cost in it. Cost is a lower bound unless this is 0.
  callsWithoutCost: number;
  // Calls that asked for structured output (a JSON schema, or a forced tool call).
  structuredCalls: number;
  // Of those, the ones whose JSON did not parse, or that returned no tool call when one was forced.
  parseFailures: number;
};

type Meter = Omit<TurnMetrics, "seconds"> & { pending: Promise<void>[] };

const current = new AsyncLocalStorage<Meter>();

type Call = {
  cost: number | null;
  structured: boolean;
  parsed: boolean;
};

// What a chat request asked for: a JSON answer, or one forced tool call.
export function asksForStructure(request: unknown): "json" | "tool" | null {
  const body = request as { response_format?: { type?: string }; tool_choice?: unknown } | null;
  if (body?.response_format?.type === "json_schema" || body?.response_format?.type === "json_object") return "json";
  const choice = body?.tool_choice;
  if (choice && typeof choice === "object") return "tool";
  if (choice === "required") return "tool";
  return null;
}

const parses = (text: unknown): boolean => {
  if (typeof text !== "string") return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
};

type Message = { content?: unknown; tool_calls?: Array<{ function?: { arguments?: unknown } }> };

function judge(kind: "json" | "tool" | null, message: Message | undefined): boolean {
  if (kind === "json") return parses(message?.content);
  if (kind === "tool") {
    const calls = message?.tool_calls ?? [];
    return calls.length > 0 && calls.every((call) => parses(call.function?.arguments));
  }
  return true;
}

// A non-streaming answer: choices[0].message and usage.
export function readJsonCall(kind: "json" | "tool" | null, body: unknown): Call {
  const { usage, choices } = (body ?? {}) as { usage?: { cost?: unknown }; choices?: Array<{ message?: Message }> };
  return { cost: typeof usage?.cost === "number" ? usage.cost : null, structured: kind !== null, parsed: judge(kind, choices?.[0]?.message) };
}

// A streamed answer (server-sent events): join the deltas, then judge the joined message.
export function readStreamCall(kind: "json" | "tool" | null, text: string): Call {
  let cost: number | null = null;
  let content = "";
  const calls = new Map<number, string>();
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const data = line.slice(5).trim();
    if (!data || data === "[DONE]") continue;
    let chunk: { usage?: { cost?: unknown }; choices?: Array<{ delta?: { content?: unknown; tool_calls?: Array<{ index?: number; function?: { arguments?: string } }> } }> };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (typeof chunk.usage?.cost === "number") cost = chunk.usage.cost;
    const delta = chunk.choices?.[0]?.delta;
    if (typeof delta?.content === "string") content += delta.content;
    for (const call of delta?.tool_calls ?? []) calls.set(call.index ?? 0, (calls.get(call.index ?? 0) ?? "") + (call.function?.arguments ?? ""));
  }
  const message: Message = { content, tool_calls: [...calls.values()].map((args) => ({ function: { arguments: args } })) };
  return { cost, structured: kind !== null, parsed: judge(kind, message) };
}

function add(meter: Meter, call: Call) {
  meter.calls += 1;
  if (call.cost === null) meter.callsWithoutCost += 1;
  else meter.costUsd += call.cost;
  if (call.structured) {
    meter.structuredCalls += 1;
    if (!call.parsed) meter.parseFailures += 1;
  }
}

// Wraps a fetch so a turn's model calls are counted. The caller still gets the untouched response:
// the copy is read in the background and the turn waits for it before it reports (measureTurn).
export function meteredFetch(send: typeof fetch): typeof fetch {
  return async (url, init) => {
    const meter = current.getStore();
    const response = await send(url, init);
    if (!meter || !response.ok) return response;
    let kind: ReturnType<typeof asksForStructure> = null;
    try {
      kind = typeof init?.body === "string" ? asksForStructure(JSON.parse(init.body)) : null;
    } catch {
      kind = null;
    }
    const copy = response.clone();
    const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
    meter.pending.push(
      (streamed ? copy.text().then((text) => readStreamCall(kind, text)) : copy.json().then((body) => readJsonCall(kind, body)))
        .then((call) => add(meter, call))
        .catch(() => {
          // A body that is not JSON at all is a failed parse when structure was asked for.
          add(meter, { cost: null, structured: kind !== null, parsed: false });
        })
    );
    return response;
  };
}

// Runs one turn and returns what it cost. The metrics are reported even when the turn throws.
export async function measureTurn<T>(run: () => Promise<T>, report: (metrics: TurnMetrics) => void | Promise<void>): Promise<T> {
  const meter: Meter = { calls: 0, costUsd: 0, callsWithoutCost: 0, structuredCalls: 0, parseFailures: 0, pending: [] };
  const started = performance.now();
  try {
    return await current.run(meter, run);
  } finally {
    await Promise.allSettled(meter.pending);
    const { pending: _pending, ...counts } = meter;
    await Promise.resolve(report({ seconds: (performance.now() - started) / 1000, ...counts })).catch((error: Error) =>
      console.warn(`The turn metrics were not recorded: ${error.message}`)
    );
  }
}

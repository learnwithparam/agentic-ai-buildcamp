// Turns one chat turn's Langfuse trace into hops: which part called which, the call's name, and
// short excerpts of what went in and came out. lwp-canvas draws these hops as the path one
// question takes through the app (docs/flows/<checkpoint>/<example>.json).
// The box names (turn, router, model, agent, search, read, cite, reply) are the canvas module's boxes.

export type Observation = {
  id: string;
  name?: string | null;
  type: string;
  startTime: string;
  endTime?: string | null;
  parentObservationId?: string | null;
  input?: unknown;
  output?: unknown;
};
export type Hop = { from: string; to: string; call: string; in?: string; out?: string; ms?: number };

// A tool with a box of its own. Any other tool is drawn under its own name, and the canvas check
// fails until the module gets a box for it.
const TOOL_BOX: Record<string, string> = { search_labels: "search", read_section: "read" };
const LIMIT = 320;

// Langfuse keeps most inputs and outputs as JSON text, so each is read back into a value first.
const parse = (value: unknown): any => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
};
const cut = (value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}...` : text;
};
const took = (o: Observation) => (o.endTime ? Date.parse(o.endTime) - Date.parse(o.startTime) : undefined);
const plain = (text: string) => text.replace(/\*\*/g, "").replace(/\n{2,}/g, "\n").trim();
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => part?.text ?? "").join("") : "";

// What the model asked for: each tool call as `name {args}`, or its written answer.
function modelOut(output: unknown): string {
  const value = parse(output);
  const calls = value?.tool_calls as Array<{ function: { name: string; arguments: string } }> | undefined;
  if (calls?.length) return cut(calls.map((call) => `${call.function.name} ${call.function.arguments}`).join("\n"));
  return cut(plain(typeof value === "string" ? value : textOf(value?.content)));
}

// What a tool sent back: search results as one line per section with its score, else the reply cut short.
function toolOut(name: string, output: unknown): string {
  const value = parse(output);
  if (name === "search_labels" && Array.isArray(value?.results))
    return value.results.map((hit: any) => `${hit.doc_id} ${hit.section}  ${Number(hit.score).toFixed(3)}`).join("\n");
  if (name === "read_section" && value && typeof value === "object")
    return cut({ found: value.found, title: value.title, status: value.status });
  return cut(value);
}

export function hopsOf(observations: Observation[]): { q: string; reply: string; tier: string; hops: Hop[] } {
  const all = [...observations].sort((a, b) => a.startTime.localeCompare(b.startTime));
  const root = all.find((o) => o.name === "hcp-medinfo-chat-turn");
  if (!root) throw new Error("this trace has no hcp-medinfo-chat-turn span, so it is not one chat turn");
  const messages = (parse(root.output)?.messages ?? []) as Array<{ type: string; content: unknown }>;
  const asked = (parse(root.input)?.messages ?? []) as Array<{ type: string; content: unknown }>;
  const q = textOf(asked.filter((m) => m.type === "human").at(-1)?.content);
  const reply = plain(textOf(messages.filter((m) => m.type === "ai").at(-1)?.content));
  const byId = new Map(all.map((o) => [o.id, o]));
  const firstAgent = all.find((o) => o.name === "agent");
  const hops: Hop[] = [];
  let tier = "";
  for (const o of all) {
    const parent = byId.get(o.parentObservationId ?? "")?.name;
    if (o.name === "router" && o.type !== "GENERATION") hops.push({ from: "turn", to: "router", call: "router", in: cut(parse(o.input)) });
    else if (o.name === "route" && o.type === "GENERATION") {
      const call = parse(o.output)?.tool_calls?.[0]?.function?.arguments;
      const route = parse(call) ?? {};
      tier = String(route.tier ?? "");
      hops.push({ from: "router", to: "model", call: "route", out: cut({ tier: route.tier, reason: route.reason, ...(route.basis ? { basis: route.basis } : {}) }), ms: took(o) });
      if (firstAgent) {
        const given = parse(firstAgent.input) ?? {};
        const tools = (given.tools ?? []) as string[];
        hops.push({ from: "router", to: "agent", call: `tier ${tier}`, out: `The question and ${tools.length} tools: ${tools.join(", ")}` });
      } else hops.push({ from: "router", to: "reply", call: `tier ${tier}`, out: cut(reply) });
    } else if (o.type === "GENERATION" && parent === "agent") hops.push({ from: "agent", to: "model", call: o.name ?? "model", out: modelOut(o.output), ms: took(o) });
    else if (o.type === "TOOL" && o.name)
      hops.push({ from: "agent", to: TOOL_BOX[o.name] ?? o.name, call: o.name, in: cut(parse(o.input)), out: toolOut(o.name, o.output), ms: took(o) });
    else if (o.name === "cite" && o.type === "SPAN") {
      const given = parse(o.input) ?? {};
      hops.push({ from: "agent", to: "cite", call: "cite", in: cut({ sections: given.sections }), out: cut(parse(o.output)) });
    }
  }
  if (firstAgent) hops.push({ from: hops.some((h) => h.to === "cite") ? "cite" : "agent", to: "reply", call: "reply", out: cut(reply) });
  for (const hop of hops) for (const key of ["in", "out", "ms"] as const) if (hop[key] === undefined || hop[key] === "") delete hop[key];
  return { q, reply, tier, hops };
}

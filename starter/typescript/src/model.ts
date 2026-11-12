// One model call through the Messages API. The model id comes from config/models.ts in the course repo.
// No key, no call: the agent carries on without a draft.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function modelId(): Promise<string> {
  if (process.env.MODEL) return process.env.MODEL;
  for (let d = import.meta.dir; d !== dirname(d); d = dirname(d))
    if (existsSync(join(d, "config", "models.ts"))) return (await import(join(d, "config", "models.ts"))).MODELS.default;
  throw new Error("set MODEL, or keep this employee inside the course repo so config/models.ts is found");
}

export const canAsk = () => Boolean(process.env.ANTHROPIC_API_KEY) && process.env.MODEL_MODE !== "replay";

export async function ask(system: string, user: string) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || !canAsk()) return null;
  const model = await modelId();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`model call failed: HTTP ${res.status}`);
  const b: any = await res.json();
  return { model, text: b.content.map((c: any) => c.text ?? "").join(""), input_tokens: b.usage.input_tokens, output_tokens: b.usage.output_tokens };
}

// One model call. Replay mode (the default) answers from recorded replies in reference/replay/, so the
// reference, the board and CI run with no model key. MODEL_MODE=live calls the API; MODEL_MODE=record also saves.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MODELS } from "../../config/models";

export const REPLAY_DIR = process.env.REPLAY_DIR ?? join(import.meta.dir, "..", "replay");
export type Reply = { text: string; model: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };

export const replayKey = (role: string, system: string, user: string) =>
  createHash("sha256").update(JSON.stringify({ role, system, user })).digest("hex").slice(0, 16);

export async function chat(label: string, system: string, user: string, role: keyof typeof MODELS = "default"): Promise<Reply> {
  const mode = process.env.MODEL_MODE ?? "replay";
  const model = MODELS[role];
  const key = replayKey(role, system, user);
  if (mode === "replay") {
    const hit = existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).find((f) => f.endsWith(`--${key}.json`)) : undefined;
    if (!hit) throw new Error(`no recorded reply for ${label} (key ${key}). Record one with MODEL_MODE=record and a model key.`);
    const r = JSON.parse(readFileSync(join(REPLAY_DIR, hit), "utf8"));
    return { text: r.reply, model, usage: r.usage };
  }
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("MODEL_MODE is live but ANTHROPIC_API_KEY is not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
    body: JSON.stringify({ model, max_tokens: 400, system, messages: [{ role: "user", content: user }] }),
  });
  if (!res.ok) throw new Error(`model call failed: HTTP ${res.status} ${await res.text()}`);
  const body: any = await res.json();
  const reply: Reply = {
    text: body.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join(""),
    model,
    usage: { input_tokens: body.usage.input_tokens, output_tokens: body.usage.output_tokens, cache_read_input_tokens: body.usage.cache_read_input_tokens ?? 0 },
  };
  if (mode === "record") {
    mkdirSync(REPLAY_DIR, { recursive: true });
    writeFileSync(join(REPLAY_DIR, `${label}--${key}.json`), JSON.stringify({ label, role, reply: reply.text, usage: reply.usage, source: "recorded" }, null, 2) + "\n");
  }
  return reply;
}

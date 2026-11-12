// One model call, by role. Replay (the default) answers from recorded replies in reference/replay/, so the
// reference, the board and CI run with no model key. LLM_PROVIDER=anthropic, openrouter or openai calls that
// provider through config/models.ts; MODEL_MODE=record also saves each reply to reference/replay/.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { languageModel, modelId, provider, type Role } from "../../config/models";

export const REPLAY_DIR = process.env.REPLAY_DIR ?? join(import.meta.dir, "..", "replay");
export type Reply = { text: string; model: string; usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number } };

export const replayKey = (role: Role, system: string, user: string) =>
  createHash("sha256").update(JSON.stringify({ role, system, user })).digest("hex").slice(0, 16);

export async function chat(label: string, system: string, user: string, role: Role = "fast"): Promise<Reply> {
  const record = process.env.MODEL_MODE === "record";
  const env = record ? { ...process.env, MODEL_MODE: undefined } : process.env;
  const p = provider(env);
  const model = modelId(role, p);
  const key = replayKey(role, system, user);
  if (p === "replay") {
    if (record) throw new Error("MODEL_MODE=record needs a live provider. Set LLM_PROVIDER=anthropic (or openrouter, openai) and its key in .env.");
    const hit = existsSync(REPLAY_DIR) ? readdirSync(REPLAY_DIR).find((f) => f.endsWith(`--${key}.json`)) : undefined;
    if (!hit) throw new Error(`no recorded reply for ${label} (key ${key}). Record one with MODEL_MODE=record, a live LLM_PROVIDER and its key.`);
    const r = JSON.parse(readFileSync(join(REPLAY_DIR, hit), "utf8"));
    return { text: r.reply, model, usage: r.usage };
  }
  const { generateText } = await import("ai");
  const out = await generateText({ model: await languageModel(role, p, env), system, prompt: user, maxOutputTokens: 400 });
  const reply: Reply = {
    text: out.text,
    model,
    usage: { input_tokens: out.usage.inputTokens ?? 0, output_tokens: out.usage.outputTokens ?? 0, cache_read_input_tokens: out.usage.inputTokenDetails?.cacheReadTokens ?? 0 },
  };
  if (record) {
    mkdirSync(REPLAY_DIR, { recursive: true });
    writeFileSync(join(REPLAY_DIR, `${label}--${key}.json`), JSON.stringify({ label, role, reply: reply.text, usage: reply.usage, source: `recorded on ${p}` }, null, 2) + "\n");
  }
  return reply;
}

// bun run models: one tiny call per role on the chosen provider. Prints the provider, the role, pass or fail and
// the cost. It never prints a key. LLM_PROVIDER=replay (the default) answers from config/replay/ with no key.
// MODEL_MODE=record with a live provider saves each reply there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { costUsd, languageModel, modelId, provider, ROLES, type Role } from "../config/models";

const REPLAY = join(import.meta.dir, "..", "config", "replay");
const PROMPT = "Reply with the single word: pass";
const record = process.env.MODEL_MODE === "record";
const env = record ? { ...process.env, MODEL_MODE: undefined } : process.env;
let p: ReturnType<typeof provider>;
try {
  p = provider(env);
} catch (e) {
  console.log((e as Error).message);
  process.exit(2);
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
async function call(role: Role): Promise<{ text: string; usage: Usage }> {
  const file = join(REPLAY, `models-${role}.json`);
  if (p === "replay") {
    if (!existsSync(file))
      throw new Error(`no recorded reply for the ${role} role in config/replay/`);
    const r = JSON.parse(readFileSync(file, "utf8"));
    return { text: r.reply, usage: r.usage };
  }
  const { generateText } = await import("ai");
  const out = await generateText({
    model: await languageModel(role, p, env),
    prompt: PROMPT,
    maxOutputTokens: 16,
  });
  const usage = {
    input_tokens: out.usage.inputTokens ?? 0,
    output_tokens: out.usage.outputTokens ?? 0,
    cache_read_input_tokens: out.usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
  if (record)
    writeFileSync(
      file,
      JSON.stringify(
        { role, prompt: PROMPT, reply: out.text, usage, source: `recorded on ${p}` },
        null,
        2,
      ) + "\n",
    );
  return { text: out.text, usage };
}

console.log(`Provider: ${p}${p === "replay" ? " (recorded replies, no key)" : ""}`);
let failed = 0;
for (const role of ROLES) {
  try {
    const r = await call(role);
    const ok = /\bpass\b/i.test(r.text);
    if (!ok) failed++;
    const usd = costUsd(
      modelId(role, p),
      r.usage.input_tokens,
      r.usage.output_tokens,
      r.usage.cache_read_input_tokens,
    );
    const cost =
      usd === null ? "cost unknown (no price in config/models.ts)" : `cost USD ${usd.toFixed(8)}`;
    console.log(
      `  ${role.padEnd(6)} ${ok ? "pass" : "fail"}  ${r.usage.input_tokens} in, ${r.usage.output_tokens} out, ${cost}`,
    );
  } catch (e) {
    failed++;
    console.log(`  ${role.padEnd(6)} fail  ${(e as Error).message}`);
  }
}
console.log(failed ? `${failed} role(s) failed.` : "Every role answered.");
process.exit(failed ? 1 : 0);

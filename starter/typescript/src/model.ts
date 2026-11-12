// One model call, by role. The provider and the model come from config/models.ts in the course repo, set by
// LLM_PROVIDER (replay, anthropic, openrouter or openai). Replay, the default, makes no call: the agent carries
// on without a draft.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

async function config() {
  for (let d = import.meta.dir; d !== dirname(d); d = dirname(d))
    if (existsSync(join(d, "config", "models.ts")))
      return await import(join(d, "config", "models.ts"));
  throw new Error("keep this employee inside the course repo so config/models.ts is found");
}

export const canAsk = async () => (await config()).provider() !== "replay";

export async function ask(system: string, user: string, role: "fast" | "smart" | "judge" = "fast") {
  const cfg = await config();
  if (cfg.provider() === "replay") return null;
  const { generateText } = await import("ai");
  const out = await generateText({
    model: await cfg.languageModel(role),
    system,
    prompt: user,
    maxOutputTokens: 400,
  });
  return {
    model: cfg.modelId(role),
    text: out.text,
    input_tokens: out.usage.inputTokens ?? 0,
    output_tokens: out.usage.outputTokens ?? 0,
  };
}

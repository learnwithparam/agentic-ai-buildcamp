// One model call, by role. The provider and the model come from config/models.ts in the course
// repo, set by LLM_PROVIDER (replay, anthropic, openrouter or openai). Replay, the default, makes
// no call: the agent carries on without a draft.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

type Role = "fast" | "smart" | "judge";

// Walk up from this file until a folder holds config/models.ts.
async function loadModelConfig() {
  for (let folder = import.meta.dir; folder !== dirname(folder); folder = dirname(folder)) {
    const modelsFile = join(folder, "config", "models.ts");
    if (existsSync(modelsFile)) return await import(modelsFile);
  }
  throw new Error("keep this employee inside the course repo so config/models.ts is found");
}

export async function canAsk() {
  const modelConfig = await loadModelConfig();
  return modelConfig.provider() !== "replay";
}

export async function ask(system: string, user: string, role: Role = "fast") {
  const modelConfig = await loadModelConfig();
  if (modelConfig.provider() === "replay") return null;
  const { generateText } = await import("ai");
  const reply = await generateText({
    model: await modelConfig.languageModel(role),
    system,
    prompt: user,
    maxOutputTokens: 400,
  });
  return {
    model: modelConfig.modelId(role),
    text: reply.text,
    input_tokens: reply.usage.inputTokens ?? 0,
    output_tokens: reply.usage.outputTokens ?? 0,
  };
}

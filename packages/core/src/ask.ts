// One model call. In replay it reads a recording. On a live provider it calls the model.
// MODEL_MODE=record with a live provider also saves the reply for replay.
// Each call is a span. It holds the tokens and the cost of the answer. The cost is what
// OpenRouter charged for the call, read from the reply.
import { generateText } from "ai";
import { languageModel, modelId, provider, type Role } from "../../../config/models";
import { type Recorded, replayReply, saveRecording } from "./replay";
import { type Tags, traced } from "./telemetry";

async function callModel(role: Role, prompt: string): Promise<Recorded> {
  if (provider() === "replay") return replayReply(role, prompt);
  const model = await languageModel(role);
  const result = await generateText({ model, prompt });
  const billed = result.providerMetadata?.openrouter?.usage as { cost?: number } | undefined;
  const reply = {
    text: result.text,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
    costUsd: billed?.cost ?? -1,
  };
  if (process.env.MODEL_MODE === "record") saveRecording(role, prompt, reply);
  return reply;
}

export async function ask(role: Role, prompt: string, tags: Tags): Promise<Recorded> {
  return traced(
    `llm.${role}`,
    tags,
    async (setAttributes) => {
      const reply = await callModel(role, prompt);
      setAttributes({
        "llm.model_name": modelId(role),
        "llm.token_count.prompt": reply.inputTokens,
        "llm.token_count.completion": reply.outputTokens,
        cost_usd: reply.costUsd,
      });
      return reply;
    },
    "LLM",
  );
}

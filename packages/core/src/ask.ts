// One model call. In replay it reads a recording. On a live provider it calls the model.
// MODEL_MODE=record with a live provider also saves the reply for replay.
import { generateText } from "ai";
import { languageModel, provider, type Role } from "../../../config/models";
import { type Recorded, replayReply, saveRecording } from "./replay";

export async function ask(role: Role, prompt: string): Promise<Recorded> {
  if (provider() === "replay") return replayReply(role, prompt);
  const model = await languageModel(role);
  const result = await generateText({ model, prompt });
  const reply = {
    text: result.text,
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  };
  if (process.env.MODEL_MODE === "record") saveRecording(role, prompt, reply);
  return reply;
}

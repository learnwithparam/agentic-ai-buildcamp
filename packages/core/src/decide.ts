// A decision is a choice between named options. It does not write text. The decide model reads the
// facts, picks one option and says how sure it is. It runs on the OpenRouter decisions endpoint.
// In replay it reads a recording, like every other model call.
import { CALL_TIMEOUT_MS, modelId, OPENROUTER_API, provider } from "../../../config/models";
import { replayReply, saveRecording } from "./replay";
import { type Tags, traced } from "./telemetry";

export type Decision = { choice: string; confidence: number; costUsd: number };

const ENDPOINT = `${OPENROUTER_API}/alpha/decisions`;

async function callDecisionModel(
  facts: string,
  instructions: string,
  options: Record<string, string>,
) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId("decide"),
      state: { facts },
      questions: { pick: { type: "choice", instructions, criteria: options } },
    }),
  });
  const body = (await response.json()) as {
    answers?: { pick?: { choice: string; confidence: number } };
    usage?: { cost?: number };
    error?: { message: string };
  };
  const pick = body.answers?.pick;
  if (!response.ok || pick === undefined) {
    throw new Error(`The decide model failed: ${body.error?.message ?? response.status}`);
  }
  return { choice: pick.choice, confidence: pick.confidence, costUsd: body.usage?.cost ?? -1 };
}

export async function decideAmong(
  facts: string,
  instructions: string,
  options: Record<string, string>,
  tags: Tags,
): Promise<Decision> {
  const prompt = JSON.stringify([facts, instructions, options]);
  return traced(
    "llm.decide",
    tags,
    async (setAttributes) => {
      let found: Decision;
      if (provider() === "replay") {
        const recorded = replayReply("decide", prompt);
        found = { choice: recorded.text, confidence: 1, costUsd: recorded.costUsd };
      } else {
        found = await callDecisionModel(facts, instructions, options);
        if (process.env.MODEL_MODE === "record") {
          const reply = {
            text: found.choice,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: found.costUsd,
          };
          saveRecording("decide", prompt, reply);
        }
      }
      setAttributes({
        "llm.model_name": modelId("decide"),
        choice: found.choice,
        confidence: found.confidence,
        cost_usd: found.costUsd,
      });
      return found;
    },
    "LLM",
  );
}

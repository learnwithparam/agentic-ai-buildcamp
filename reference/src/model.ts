// One model call, by role. Replay (the default) answers from recorded replies in reference/replay/,
// so the reference, the board and CI run with no model key. LLM_PROVIDER=anthropic, openrouter or
// openai calls that provider through config/models.ts; MODEL_MODE=record also saves each reply to
// reference/replay/.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { languageModel, modelId, type Provider, provider, type Role } from "../../config/models";

export const REPLAY_DIR = process.env.REPLAY_DIR ?? join(import.meta.dir, "..", "replay");
export type Reply = {
  text: string;
  model: string;
  usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
};

// One saved reply in reference/replay/<label>--<key>.json.
type Recording = {
  label: string;
  role: Role;
  reply: string;
  usage: Reply["usage"];
  source: string;
};

type Environment = typeof process.env;
type ChatRequest = { label: string; role: Role; system: string; user: string };

export const replayKey = (role: Role, system: string, user: string) => {
  const hash = createHash("sha256").update(JSON.stringify({ role, system, user }));
  return hash.digest("hex").slice(0, 16);
};

// Recording needs a live provider, so MODEL_MODE=record must not make the provider "replay".
function environmentFor(record: boolean): Environment {
  if (!record) return process.env;
  const environment = { ...process.env };
  environment.MODEL_MODE = undefined;
  return environment;
}

function replayedReply(request: ChatRequest, key: string, model: string): Reply {
  const fileEnding = `--${key}.json`;
  let fileName: string | undefined;
  if (existsSync(REPLAY_DIR)) {
    fileName = readdirSync(REPLAY_DIR).find((name) => name.endsWith(fileEnding));
  }
  if (!fileName)
    throw new Error(
      `no recorded reply for ${request.label} (key ${key}). ` +
        "Record one with MODEL_MODE=record, a live LLM_PROVIDER and its key.",
    );
  const recording = JSON.parse(readFileSync(join(REPLAY_DIR, fileName), "utf8")) as Recording;
  return { text: recording.reply, model, usage: recording.usage };
}

async function liveReply(
  request: ChatRequest,
  liveProvider: Provider,
  environment: Environment,
): Promise<Reply> {
  const { generateText } = await import("ai");
  const result = await generateText({
    model: await languageModel(request.role, liveProvider, environment),
    system: request.system,
    prompt: request.user,
    maxOutputTokens: 400,
  });
  return {
    text: result.text,
    model: modelId(request.role, liveProvider),
    usage: {
      input_tokens: result.usage.inputTokens ?? 0,
      output_tokens: result.usage.outputTokens ?? 0,
      cache_read_input_tokens: result.usage.inputTokenDetails?.cacheReadTokens ?? 0,
    },
  };
}

function saveRecording(request: ChatRequest, key: string, reply: Reply, liveProvider: Provider) {
  mkdirSync(REPLAY_DIR, { recursive: true });
  const recording: Recording = {
    label: request.label,
    role: request.role,
    reply: reply.text,
    usage: reply.usage,
    source: `recorded on ${liveProvider}`,
  };
  const file = join(REPLAY_DIR, `${request.label}--${key}.json`);
  writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
}

export async function chat(
  label: string,
  system: string,
  user: string,
  role: Role = "fast",
): Promise<Reply> {
  const request: ChatRequest = { label, role, system, user };
  const record = process.env.MODEL_MODE === "record";
  const environment = environmentFor(record);
  const chosenProvider = provider(environment);
  const model = modelId(role, chosenProvider);
  const key = replayKey(role, system, user);
  if (chosenProvider === "replay") {
    if (record)
      throw new Error(
        "MODEL_MODE=record needs a live provider. " +
          "Set LLM_PROVIDER=anthropic (or openrouter, openai) and its key in .env.",
      );
    return replayedReply(request, key, model);
  }
  const reply = await liveReply(request, chosenProvider, environment);
  if (record) saveRecording(request, key, reply, chosenProvider);
  return reply;
}

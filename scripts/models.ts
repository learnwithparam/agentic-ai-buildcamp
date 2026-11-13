// bun run models: one tiny call per role on the chosen provider. Prints the provider, the role,
// pass or fail and the cost. It never prints a key. LLM_PROVIDER=replay (the default) answers from
// config/replay/ with no key. MODEL_MODE=record with a live provider saves each reply there.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  costUsd,
  languageModel,
  modelId,
  type Provider,
  provider,
  ROLES,
  type Role,
} from "../config/models";

const REPLAY = join(import.meta.dir, "..", "config", "replay");
const PROMPT = "Reply with the single word: pass";
const record = process.env.MODEL_MODE === "record";
// Recording needs a live call, so MODEL_MODE is left out: provider() would otherwise force replay.
const { MODEL_MODE: _modelMode, ...environmentWithoutModelMode } = process.env;
const environment = record ? environmentWithoutModelMode : process.env;
let chosenProvider: Provider;
try {
  chosenProvider = provider(environment);
} catch (error) {
  console.log((error as Error).message);
  process.exit(2);
}

type Usage = { input_tokens: number; output_tokens: number; cache_read_input_tokens: number };
type Answer = { text: string; usage: Usage };

function recordedAnswer(role: Role, file: string): Answer {
  if (!existsSync(file))
    throw new Error(`no recorded reply for the ${role} role in config/replay/`);
  const recording = JSON.parse(readFileSync(file, "utf8"));
  return { text: recording.reply, usage: recording.usage };
}

async function liveAnswer(role: Role, file: string): Promise<Answer> {
  const { generateText } = await import("ai");
  const reply = await generateText({
    model: await languageModel(role, chosenProvider, environment),
    prompt: PROMPT,
    maxOutputTokens: 16,
  });
  const usage = {
    input_tokens: reply.usage.inputTokens ?? 0,
    output_tokens: reply.usage.outputTokens ?? 0,
    cache_read_input_tokens: reply.usage.inputTokenDetails?.cacheReadTokens ?? 0,
  };
  if (record) {
    const source = `recorded on ${chosenProvider}`;
    const recording = { role, prompt: PROMPT, reply: reply.text, usage, source };
    writeFileSync(file, `${JSON.stringify(recording, null, 2)}\n`);
  }
  return { text: reply.text, usage };
}

async function call(role: Role): Promise<Answer> {
  const file = join(REPLAY, `models-${role}.json`);
  if (chosenProvider === "replay") return recordedAnswer(role, file);
  return liveAnswer(role, file);
}

function costText(role: Role, usage: Usage): string {
  const usd = costUsd(
    modelId(role, chosenProvider),
    usage.input_tokens,
    usage.output_tokens,
    usage.cache_read_input_tokens,
  );
  if (usd === null) return "cost unknown (no price in config/models.ts)";
  return `cost USD ${usd.toFixed(8)}`;
}

// Calls one role and prints its line. Returns whether the role answered "pass".
async function tryRole(role: Role): Promise<boolean> {
  try {
    const answer = await call(role);
    const ok = /\bpass\b/i.test(answer.text);
    const tokens = `${answer.usage.input_tokens} in, ${answer.usage.output_tokens} out`;
    const verdict = ok ? "pass" : "fail";
    console.log(`  ${role.padEnd(6)} ${verdict}  ${tokens}, ${costText(role, answer.usage)}`);
    return ok;
  } catch (error) {
    console.log(`  ${role.padEnd(6)} fail  ${(error as Error).message}`);
    return false;
  }
}

let replayNote = "";
if (chosenProvider === "replay") replayNote = " (recorded replies, no key)";
console.log(`Provider: ${chosenProvider}${replayNote}`);
let failed = 0;
for (const role of ROLES) {
  if (!(await tryRole(role))) failed++;
}
console.log(failed ? `${failed} role(s) failed.` : "Every role answered.");
process.exit(failed ? 1 : 0);

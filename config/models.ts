// The only file that names a model. Code asks for a role (fast, smart or judge), never for an id, so a learner
// swaps Anthropic, OpenRouter or OpenAI by changing LLM_PROVIDER, never the code. See briefs/MODELS.md.
//
//   LLM_PROVIDER=replay      the default: recorded replies, no key, used by CI, the checks and the first run
//   LLM_PROVIDER=anthropic   needs ANTHROPIC_API_KEY
//   LLM_PROVIDER=openrouter  needs OPENROUTER_API_KEY
//   LLM_PROVIDER=openai      needs OPENAI_API_KEY
//
// MODEL_MODE=replay (what the checker sets, see reference/CONTRACT.md) forces replay whatever LLM_PROVIDER says.
// The AI SDK packages load only when a live provider is used, so replay, the checks and CI need no install.
import type { LanguageModel } from "ai";

export const ROLES = ["fast", "smart", "judge"] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ["replay", "anthropic", "openrouter", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type LiveProvider = Exclude<Provider, "replay">;

// fast: cheap, most calls. smart: hard reasoning. judge: grading.
export const IDS: Record<LiveProvider, Record<Role, string>> = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5", judge: "claude-haiku-5-5" },
  openrouter: {
    fast: "nvidia/nemotron-3.5-lightning",
    smart: "anthropic/claude-sonnet-5.5",
    judge: "anthropic/claude-haiku-5.5",
  },
  openai: { fast: "gpt-6-luna", smart: "gpt-6-luna-pro", judge: "gpt-6-luna" },
};
// Replay answers with replies recorded on this provider, so its traces name and price that provider's ids.
export const REPLAY_RECORDED_ON: LiveProvider = "anthropic";

export const KEY_ENV: Record<LiveProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function provider(env = process.env): Provider {
  if (env.MODEL_MODE === "replay") return "replay";
  const p = (env.LLM_PROVIDER ?? "replay").trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(p))
    throw new Error(`LLM_PROVIDER is "${p}". Set it to one of: ${PROVIDERS.join(", ")}.`);
  return p as Provider;
}

// The id a role maps to on a provider. Replay maps to the ids its replies were recorded with.
export function modelId(role: Role, p: Provider = provider()): string {
  return IDS[p === "replay" ? REPLAY_RECORDED_ON : p][role];
}

// The ids for the chosen provider, by role: models.fast, models.smart, models.judge.
export const models: Record<Role, string> = {
  get fast() {
    return modelId("fast");
  },
  get smart() {
    return modelId("smart");
  },
  get judge() {
    return modelId("judge");
  },
};

// The AI SDK model for a role on a live provider. Replay has no model to call; callers answer from recordings.
export async function languageModel(
  role: Role,
  p: Provider = provider(),
  env = process.env,
): Promise<LanguageModel> {
  if (p === "replay")
    throw new Error(
      "LLM_PROVIDER is replay: answer from the recordings, there is no model to call.",
    );
  const apiKey = env[KEY_ENV[p]];
  if (!apiKey)
    throw new Error(
      `LLM_PROVIDER is ${p} but ${KEY_ENV[p]} is not set. Put it in .env (see .env.example), or use LLM_PROVIDER=replay.`,
    );
  const id = IDS[p][role];
  if (p === "anthropic") return (await import("@ai-sdk/anthropic")).createAnthropic({ apiKey })(id);
  if (p === "openrouter")
    return (await import("@openrouter/ai-sdk-provider")).createOpenRouter({ apiKey })(id);
  return (await import("@ai-sdk/openai")).createOpenAI({ apiKey })(id);
}

// Prices in USD per million tokens, read on PRICES_AS_OF from each provider's own pricing page.
// A price that could not be read is left out: its cost is reported as unknown, never as zero.
export const PRICES_AS_OF = "2026-11-12";
export const MAX_PRICE_AGE_DAYS = 60;
export type Price = {
  input: number;
  output: number;
  cache_read: number;
  source: string;
  note?: string;
};

export const PRICES: Record<string, Price> = {
  // https://claude.com/pricing, read 2026-11-12. Haiku 5.5 prices hold for prompts up to 100K tokens
  // (above that: input 0.50, output 2.50, cache read 0.05). Cache read is the 5-minute cache.
  "claude-haiku-5-5": {
    input: 0.1,
    output: 0.5,
    cache_read: 0.01,
    source: "https://claude.com/pricing",
    note: "prompts up to 100K tokens",
  },
  "claude-sonnet-5-5": {
    input: 2,
    output: 10,
    cache_read: 0.1,
    source: "https://claude.com/pricing",
  },
  // OpenRouter (https://openrouter.ai/models) and OpenAI (https://openai.com/api/pricing/) could not be read from
  // the build session on 2026-11-12, so their ids have no price here and their cost is reported as unknown.
};

export const priceOf = (id: string): Price | undefined => PRICES[id];

// Cost of one model call from its token counts, or null when the model has no price in the table.
export function costUsd(id: string, input: number, output: number, cacheRead = 0): number | null {
  const p = PRICES[id];
  if (!p) return null;
  return ((input - cacheRead) * p.input + cacheRead * p.cache_read + output * p.output) / 1_000_000;
}

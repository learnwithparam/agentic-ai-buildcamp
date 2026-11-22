// This is the only file that names a model. Code asks for a role, never for an id.
// A role is fast, smart or judge. To change provider, change LLM_PROVIDER, not the code.
//
// Set LLM_PROVIDER to one of these:
//   replay      the default. It plays back recorded replies and needs no key.
//   anthropic   needs ANTHROPIC_API_KEY.
//   openrouter  needs OPENROUTER_API_KEY.
//   openai      needs OPENAI_API_KEY.
//
// MODEL_MODE=replay forces replay, whatever LLM_PROVIDER says. The checks set it.
// The provider packages load only for a live provider. Replay needs no install.
import type { LanguageModel } from "ai";

export const ROLES = ["fast", "smart", "judge"] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ["replay", "anthropic", "openrouter", "openai"] as const;
export type Provider = (typeof PROVIDERS)[number];
export type LiveProvider = Exclude<Provider, "replay">;

// Fast is cheap and takes most calls. Smart does the hard thinking. Judge does the grading.
export const IDS: Record<LiveProvider, Record<Role, string>> = {
  anthropic: { fast: "claude-haiku-5-5", smart: "claude-sonnet-5-5", judge: "claude-haiku-5-5" },
  openrouter: {
    fast: "nvidia/nemotron-3.5-lightning",
    smart: "anthropic/claude-sonnet-5.5",
    judge: "anthropic/claude-haiku-5.5",
  },
  openai: { fast: "gpt-6-luna", smart: "gpt-6-luna-pro", judge: "gpt-6-luna" },
};
// Replay plays back replies recorded on this provider. Its traces use this provider's ids.
export const REPLAY_RECORDED_ON: LiveProvider = "anthropic";

export const KEY_ENV: Record<LiveProvider, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
  openai: "OPENAI_API_KEY",
};

export function provider(env = process.env): Provider {
  if (env.MODEL_MODE === "replay") return "replay";
  const chosen = (env.LLM_PROVIDER ?? "replay").trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(chosen)) {
    throw new Error(`LLM_PROVIDER is "${chosen}". Set it to one of: ${PROVIDERS.join(", ")}.`);
  }
  return chosen as Provider;
}

// The id a role maps to on a provider. Replay uses the ids its replies were recorded with.
export function modelId(role: Role, chosen: Provider = provider()): string {
  const recordedOn = chosen === "replay" ? REPLAY_RECORDED_ON : chosen;
  return IDS[recordedOn][role];
}

// The ids for the chosen provider, one for each role.
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

// The model for a role on a live provider. Replay has no model to call. Callers read recordings.
export async function languageModel(
  role: Role,
  chosen: Provider = provider(),
  env = process.env,
): Promise<LanguageModel> {
  if (chosen === "replay") {
    throw new Error(
      "LLM_PROVIDER is replay: answer from the recordings, there is no model to call.",
    );
  }
  const keyName = KEY_ENV[chosen];
  const apiKey = env[keyName];
  if (!apiKey) {
    throw new Error(
      `LLM_PROVIDER is ${chosen} but ${keyName} is not set. ` +
        "Put it in .env (see .env.example), or use LLM_PROVIDER=replay.",
    );
  }
  const id = IDS[chosen][role];
  if (chosen === "anthropic") {
    const { createAnthropic } = await import("@ai-sdk/anthropic");
    return createAnthropic({ apiKey })(id);
  }
  if (chosen === "openrouter") {
    const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
    return createOpenRouter({ apiKey })(id);
  }
  const { createOpenAI } = await import("@ai-sdk/openai");
  return createOpenAI({ apiKey })(id);
}

// Prices in US dollars for each million tokens. Each came from the provider's own pricing page.
// A price we could not read is left out. Its cost shows as unknown, never as zero.
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
  // From the pricing page at claude.com. These prices hold for prompts up to 100K tokens.
  // Longer prompts cost more. Cache read is the five minute cache.
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
  // We could not read the OpenRouter or OpenAI prices. Their ids have no price here.
  // Their cost shows as unknown.
};

export const priceOf = (id: string): Price | undefined => PRICES[id];

// The cost of one model call from its token counts. It is null when the model has no price.
export function costUsd(id: string, input: number, output: number, cacheRead = 0): number | null {
  const price = PRICES[id];
  if (!price) return null;
  const uncachedInput = input - cacheRead;
  const total = uncachedInput * price.input + cacheRead * price.cache_read + output * price.output;
  return total / 1_000_000;
}

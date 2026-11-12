// The only file that names a model. Everything else imports from here, so a model change is one edit.
// Prices are USD per million tokens, read from the provider's pricing page on the date below.
export const PRICES_AS_OF = "2026-11-12";
export const MAX_PRICE_AGE_DAYS = 60;

export const MODELS = {
  default: process.env.MODEL ?? "claude-haiku-5-5",
  strong: "claude-sonnet-5-5",
  top: "claude-opus-5-5",
} as const;

export const PRICES: Record<string, { input: number; output: number; cache_read: number }> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cache_read: 0.01 },
  "claude-sonnet-5-5": { input: 2, output: 10, cache_read: 0.2 },
  "claude-opus-5-5": { input: 4, output: 20, cache_read: 0.4 },
};

// Cost of one model call from its token counts. Unknown models cost nothing here and are reported by the checker.
export function costUsd(model: string, input: number, output: number, cacheRead = 0): number {
  const p = PRICES[model];
  if (!p) return 0;
  return ((input - cacheRead) * p.input + cacheRead * p.cache_read + output * p.output) / 1_000_000;
}

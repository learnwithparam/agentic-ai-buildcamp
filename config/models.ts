// This is the only file that picks a model. Code asks for a role, never for an id.
// A role is a job: fast, smart, decide, judge or vision. Each role lists what the job needs.
//
// The id for a role comes from the first of these that has one:
//   1. MODEL_<ROLE> in the environment, for example MODEL_SMART.
//   2. config/model-choice.json, written by: bun run models --measure
//   3. The cheapest model in config/model-pool.json that has what the role needs.
// Prices come from config/model-catalog.json, written by: bun run models
//
// LLM_PROVIDER is replay or openrouter. Replay is the default. It plays back recorded replies and
// needs no key. MODEL_MODE=replay forces replay. The checks set it.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { LanguageModel } from "ai";
import { MS_PER_DAY, MS_PER_MINUTE } from "../src/time";

export const ROLES = ["fast", "smart", "decide", "judge", "vision"] as const;
export type Role = (typeof ROLES)[number];
export const PROVIDERS = ["replay", "openrouter"] as const;
export type Provider = (typeof PROVIDERS)[number];

// What each job needs from a model. A model without it cannot do the job.
export const NEEDS: Record<Role, Need[]> = {
  fast: ["json"],
  smart: ["tools", "json"],
  decide: [],
  judge: ["json"],
  vision: ["image"],
};
export type Need = "tools" | "json" | "image";

export type CatalogEntry = {
  input: number; // US dollars for each million tokens
  output: number;
  context: number;
  tools: boolean;
  json: boolean;
  image: boolean;
};
export type Catalog = { fetchedAt: string; models: Record<string, CatalogEntry> };
export type Choice = { id: string; passRate: number; costPerCase: number };

const FOLDER = import.meta.dir;
// The one place that names where models are called. Code adds only the end of the path.
export const OPENROUTER_API = "https://openrouter.ai/api";
export const CALL_TIMEOUT_MS = MS_PER_MINUTE;
export const TOKENS_PER_PRICE_UNIT = 1_000_000;
export const MAX_CATALOG_AGE_DAYS = 30;

function readJson<T>(name: string, fallback: T): T {
  const file = join(FOLDER, name);
  if (!existsSync(file)) return fallback;
  return JSON.parse(readFileSync(file, "utf8")) as T;
}

export const pool = (): Record<Role, string[]> => readJson("model-pool.json", {} as never);
export const catalog = (): Catalog => readJson("model-catalog.json", { fetchedAt: "", models: {} });
export const choices = (): Partial<Record<Role, Choice>> => readJson("model-choice.json", {});

export function provider(env = process.env): Provider {
  if (env.MODEL_MODE === "replay") return "replay";
  const chosen = (env.LLM_PROVIDER ?? "replay").trim().toLowerCase();
  if (!(PROVIDERS as readonly string[]).includes(chosen)) {
    throw new Error(`LLM_PROVIDER is "${chosen}". Set it to one of: ${PROVIDERS.join(", ")}.`);
  }
  return chosen as Provider;
}

function hasNeeds(id: string, role: Role, models: Catalog["models"]): boolean {
  const entry = models[id];
  if (entry === undefined) return role === "decide";
  return NEEDS[role].every((need) => entry[need]);
}

const total = (entry: CatalogEntry) => entry.input + entry.output;

// The cheapest model in the pool that has what the role needs.
export function cheapestFor(role: Role, models = catalog().models): string {
  const fits = (pool()[role] ?? []).filter((id) => hasNeeds(id, role, models));
  const priced = fits.filter((id) => models[id] !== undefined);
  priced.sort((first, second) => total(models[first]) - total(models[second]));
  const found = priced[0] ?? fits[0];
  if (found === undefined) throw new Error(`No model in config/model-pool.json fits ${role}.`);
  return found;
}

export function modelId(role: Role, env = process.env): string {
  const forced = env[`MODEL_${role.toUpperCase()}`];
  if (forced) return forced;
  return choices()[role]?.id ?? cheapestFor(role);
}

// The model for a role. Replay has no model to call: callers read recordings.
export async function languageModel(role: Role, env = process.env): Promise<LanguageModel> {
  if (provider(env) === "replay") {
    throw new Error(
      "LLM_PROVIDER is replay: answer from the recordings, there is no model to call.",
    );
  }
  if (!env.OPENROUTER_API_KEY) {
    throw new Error(
      "LLM_PROVIDER is openrouter but OPENROUTER_API_KEY is not set. " +
        "Put it in .env (see .env.example), or use LLM_PROVIDER=replay.",
    );
  }
  const { createOpenRouter } = await import("@openrouter/ai-sdk-provider");
  const openrouter = createOpenRouter({ apiKey: env.OPENROUTER_API_KEY });
  return openrouter(modelId(role, env), { usage: { include: true } });
}

export function catalogAgeDays(now = Date.now()): number {
  const fetched = Date.parse(catalog().fetchedAt);
  return Number.isNaN(fetched) ? Number.POSITIVE_INFINITY : (now - fetched) / MS_PER_DAY;
}

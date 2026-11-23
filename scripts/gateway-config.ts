// bun run gateway-config writes infra/litellm.yaml, the config for the model gateway.
// Each role is a model name the gateway answers to. It maps to the model that config/models.ts
// picks, and falls back to the next model in the pool for that role. No model id is typed here.
// bun run gateway-config --check fails when the file on disk differs, so the two cannot drift.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { modelId, pool, type Role } from "../config/models";
import { ROOT } from "./root";

export const CONFIG_FILE = join(ROOT, "infra", "litellm.yaml");
export const GATEWAY_ROLES: Role[] = ["fast", "smart", "judge"];
export const MAX_SPEND_USD = 5;

function backupFor(role: Role): string | undefined {
  const chosen = modelId(role);
  return pool()[role].find((id) => id !== chosen);
}

function entry(name: string, id: string): string[] {
  return [
    `  - model_name: ${name}`,
    "    litellm_params:",
    `      model: openrouter/${id}`,
    "      api_key: os.environ/OPENROUTER_API_KEY",
  ];
}

export function buildConfig(): string {
  const lines = ["# Written by: bun run gateway-config. Do not edit by hand.", "model_list:"];
  const fallbacks: string[] = [];
  for (const role of GATEWAY_ROLES) {
    lines.push(...entry(role, modelId(role)));
    const backup = backupFor(role);
    if (backup === undefined) continue;
    lines.push(...entry(`${role}-backup`, backup));
    fallbacks.push(`    - ${role}: [${role}-backup]`);
  }
  lines.push("router_settings:", "  fallbacks:", ...fallbacks);
  lines.push("litellm_settings:", `  max_budget: ${MAX_SPEND_USD}`, "  drop_params: true");
  return `${lines.join("\n")}\n`;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const same = readFileSync(CONFIG_FILE, "utf8") === buildConfig();
    if (!same) throw new Error("infra/litellm.yaml is out of date. Run: bun run gateway-config");
  } else {
    writeFileSync(CONFIG_FILE, buildConfig());
    console.log("Wrote infra/litellm.yaml.");
  }
}

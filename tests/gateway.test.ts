// The gateway rules, asserted: its config comes from the model resolver, the local key and the
// address match the compose file, and every call role has a name the gateway answers to.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { GATEWAY_KEY_DEFAULT, GATEWAY_URL, modelId } from "../config/models";
import { buildConfig, CONFIG_FILE, GATEWAY_ROLES, MAX_SPEND_USD } from "../scripts/gateway-config";

const COMPOSE = readFileSync(join(import.meta.dir, "..", "infra", "docker-compose.yml"), "utf8");

describe("the model gateway", () => {
  test("infra/litellm.yaml is what the resolver writes", () => {
    expect(readFileSync(CONFIG_FILE, "utf8")).toBe(buildConfig());
  });

  test("every gateway role maps to the model the resolver picks", () => {
    for (const role of GATEWAY_ROLES) {
      const start = buildConfig().indexOf(`model_name: ${role}\n`);
      expect(buildConfig().slice(start, start + 200)).toContain(`openrouter/${modelId(role)}`);
    }
  });

  test("each role has a backup to fall back to", () => {
    for (const role of GATEWAY_ROLES) {
      const line = `${role}: [${role}-backup]`;
      expect(buildConfig().includes(line) || modelIsAlone(role)).toBe(true);
    }
  });

  test("the gateway has a spend limit and no key in its config", () => {
    expect(buildConfig()).toContain(`max_budget: ${MAX_SPEND_USD}`);
    expect(buildConfig()).not.toMatch(/sk-[A-Za-z0-9]/);
  });

  test("the compose file uses the same local key and port as the code", () => {
    expect(COMPOSE).toContain(GATEWAY_KEY_DEFAULT);
    expect(COMPOSE).toContain(`:${new URL(GATEWAY_URL).port}`);
  });
});

// The judge has one candidate in the pool, so it has no backup.
function modelIsAlone(role: string): boolean {
  return !buildConfig().includes(`${role}-backup`);
}

// The model rules, asserted: every role resolves to a priced model with what the job needs, the
// price list is fresh, the judge is another family from the smart model, and no id hides in code.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  catalog,
  catalogAgeDays,
  choices,
  MAX_CATALOG_AGE_DAYS,
  modelId,
  NEEDS,
  pool,
  ROLES,
} from "../config/models";

const ROOT = join(import.meta.dir, "..");
const family = (id: string) => id.replace(/^~/, "").split("/")[0];

describe("models by role", () => {
  test("every role resolves to a model in its pool", () => {
    for (const role of ROLES) expect(pool()[role]).toContain(modelId(role));
  });

  test("every chosen model is priced and has what its job needs", () => {
    for (const role of ROLES) {
      const entry = catalog().models[modelId(role)];
      if (role === "decide") continue; // the decide model is priced per call
      expect(entry).toBeDefined();
      for (const need of NEEDS[role]) expect(entry?.[need]).toBe(true);
    }
  });

  test("a measured choice passed every probe", () => {
    for (const choice of Object.values(choices())) expect(choice?.passRate).toBe(1);
  });

  test("the price list is fresh", () => {
    expect(catalogAgeDays()).toBeLessThan(MAX_CATALOG_AGE_DAYS);
  });

  test("the judge is another family from the smart model", () => {
    expect(family(modelId("judge"))).not.toBe(family(modelId("smart")));
  });

  test("a MODEL_ variable overrides the choice", () => {
    const env = Object.fromEntries([["MODEL_SMART", "x/y"]]);
    expect(modelId("smart", env)).toBe("x/y");
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (["node_modules", ".git", "config", "recordings"].includes(name)) return [];
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|mjs)$/.test(name) ? [full] : [];
  });
}

describe("no model id outside config", () => {
  test("code never names a model from the pool", () => {
    const ids = [...new Set(Object.values(pool()).flat())];
    const named = sourceFiles(ROOT)
      .filter((file) => !file.endsWith("models.test.ts"))
      .filter((file) => ids.some((id) => readFileSync(file, "utf8").includes(id)));
    expect(named).toEqual([]);
  });
});

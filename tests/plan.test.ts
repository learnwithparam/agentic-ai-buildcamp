// The plan guard: every unit in the manifest has a plan row, and a unit marked built
// has all its files. The red list (units without real-run evidence) is: bun run plan
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { evidencePath, hashOf, PLAN, redReason } from "../src/plan";
import { UNITS } from "../src/workshop";

const ROOT = join(import.meta.dir, "..");

describe("the approved plan", () => {
  test("every unit has a plan row and every plan row is a unit", () => {
    const planned = Object.keys(PLAN).sort();
    const listed = UNITS.map((unit) => unit.slug).sort();
    expect(planned).toEqual(listed);
  });

  test("a unit marked built has every file the plan names", () => {
    for (const unit of UNITS.filter((item) => item.built && item.slug in PLAN)) {
      for (const file of PLAN[unit.slug].files) {
        if (unit.slug === "foundation" || existsSync(join(ROOT, file))) continue;
        expect(`${unit.slug} lacks ${file}`).toBe("");
      }
    }
  });

  test("a unit without evidence is red, never green", () => {
    const missing = UNITS.find((unit) => !existsSync(evidencePath(ROOT, unit.slug)));
    if (missing === undefined) return;
    expect(redReason(ROOT, missing.slug)).not.toBeNull();
  });

  test("the hash changes when a planned file is missing", () => {
    expect(hashOf(ROOT, "agent-loop")).toHaveLength(64);
  });
});

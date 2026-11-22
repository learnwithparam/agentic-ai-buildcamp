// The manifest is the one list of units. This walks it and checks every rule about the list itself.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../scripts/root";
import { pageFor, stemFor, tagFor, UNITS, unitBySlug } from "../src/workshop";

describe("the manifest", () => {
  test("every slug is unique", () => {
    expect(new Set(UNITS.map((unit) => unit.slug)).size).toBe(UNITS.length);
  });
  test("modules come before labs", () => {
    const firstLab = UNITS.findIndex((unit) => unit.kind === "lab");
    expect(UNITS.slice(firstLab).every((unit) => unit.kind === "lab")).toBe(true);
  });
  test("each unit needs one earlier unit that exists", () => {
    UNITS.forEach((unit, index) => {
      if (unit.needs === null) return;
      const earlier = UNITS.findIndex((other) => other.slug === unit.needs);
      expect(earlier).toBeGreaterThanOrEqual(0);
      expect(earlier).toBeLessThan(index);
    });
  });
  test("a lab starts after a module that exists", () => {
    for (const lab of UNITS.filter((unit) => unit.kind === "lab")) {
      expect(unitBySlug(lab.after ?? "")?.kind).toBe("module");
    }
  });
  test("no number appears in a title or a job", () => {
    for (const unit of UNITS) expect(/\d/.test(`${unit.title} ${unit.job}`)).toBe(false);
  });
  test("tags are numbered in order and never collide", () => {
    const tags = UNITS.map((unit) => tagFor(unit.slug));
    expect(new Set(tags).size).toBe(tags.length);
    expect(tags[0]).toBe("checkpoint/00-foundation");
  });
});

describe("a built unit is complete", () => {
  for (const unit of UNITS.filter((item) => item.built)) {
    const stem = stemFor(unit);
    test(`${unit.slug} has its parts`, () => {
      const parts = [
        pageFor(unit),
        `content/${unit.slug}.ts`,
        `checks/${unit.slug}.ts`,
        `tests/promises/${stem}.test.ts`,
      ];
      for (const part of parts) expect(existsSync(join(ROOT, part))).toBe(true);
    });
  }
});

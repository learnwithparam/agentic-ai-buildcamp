// The manifest is the one list of units. This walks it and checks every rule about the list itself.
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { MISSION_CONTROL_GOLDEN } from "../data/catalog/golden-mission-control";
import { ROOT } from "../scripts/root";
import { branchFor, pageFor, stemFor, UNITS, unitBySlug } from "../src/workshop";

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
  test("branches are numbered in order and never collide", () => {
    const tags = UNITS.map((unit) => branchFor(unit.slug));
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

describe("the golden sets", () => {
  const sets = [
    { track: "hcp", golden: HCP_GOLDEN },
    { track: "mission-control", golden: MISSION_CONTROL_GOLDEN },
  ];
  for (const { track, golden } of sets) {
    const assigned = UNITS.filter((unit) => unit.track === track).flatMap((unit) => unit.cases);
    test(`every ${track} golden case is assigned to one unit`, () => {
      const named = golden.cases.filter((item) => !item.name.startsWith("NAIVE"));
      for (const item of named) {
        expect(assigned.filter((name) => name === item.name)).toHaveLength(1);
      }
    });
    test(`every case a ${track} unit names is in its golden set`, () => {
      const known = golden.cases.map((item) => item.name);
      for (const name of assigned) expect(known).toContain(name);
    });
  }
});

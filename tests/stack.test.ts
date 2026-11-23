// The stack guard: every package the course promised is pinned at its exact version,
// and nothing that was left out on purpose has crept in.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEFT_OUT, STACK } from "../src/stack";
import { unitBySlug } from "../src/workshop";

const PACKAGE = JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const PINNED = { ...PACKAGE.dependencies, ...PACKAGE.devDependencies };

describe("the promised tech stack", () => {
  for (const row of STACK) {
    test(`${row.pkg} is pinned at ${row.version}`, () => {
      expect(PINNED[row.pkg]).toBe(row.version);
    });

    test(`${row.pkg} is taught by a real unit`, () => {
      expect(unitBySlug(row.unit) !== undefined || row.unit === "foundation").toBe(true);
    });
  }

  test("nothing left out on purpose is installed", () => {
    for (const name of LEFT_OUT) expect(PINNED[name]).toBeUndefined();
  });
});

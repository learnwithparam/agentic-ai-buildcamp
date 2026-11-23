// A published tag never moves, so no workflow may create, push or delete one.
// Checkpoints are branches. A branch may be force pushed only with a lease.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const FOLDER = join(import.meta.dir, "..", ".github", "workflows");
const TAG_COMMANDS = ["git tag", "--tags", "refs/tags", "--delete", "push -d"];

const workflows = readdirSync(FOLDER).map((name) => ({
  name,
  text: readFileSync(join(FOLDER, name), "utf8"),
}));

describe("workflows never touch a tag", () => {
  for (const { name, text } of workflows) {
    test(`${name} makes, pushes and deletes no tag`, () => {
      for (const command of TAG_COMMANDS) expect(text).not.toContain(command);
    });
    test(`${name} force pushes only with a lease`, () => {
      expect(text).not.toMatch(/push[^\n]*--force(?!-with-lease)/);
    });
  }
});

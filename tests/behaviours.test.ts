// The checks check themselves: every behaviour check passes on the reference employee and fails on
// each planted-fault employee in tests/faulty/ that targets it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type BehaviourName, behaviours } from "../checks/lib/behaviours";

const ROOT = join(import.meta.dir, "..");
const FAULTY = join(import.meta.dir, "faulty");
const TIMEOUT = 90_000;

// Each faulty employee's employee.toml names the behaviours it should fail under `fails`.
type FaultyToml = { fails: BehaviourName[] };

function faultyEmployee(name: string) {
  const dir = join(FAULTY, name);
  const toml = Bun.TOML.parse(readFileSync(join(dir, "employee.toml"), "utf8")) as FaultyToml;
  return { name, dir, fails: toml.fails };
}

const faulty = readdirSync(FAULTY).map(faultyEmployee);
const behaviourNames = Object.keys(behaviours) as BehaviourName[];

describe("the reference passes every behaviour check", () => {
  for (const name of behaviourNames) {
    test(
      name,
      async () => {
        const outcome = await behaviours[name](join(ROOT, "reference"));
        expect(outcome.message).toBe("3 of 3 fresh trials passed.");
        expect(outcome.ok).toBe(true);
      },
      TIMEOUT,
    );
  }
});

describe("each faulty employee fails the checks it targets", () => {
  for (const employee of faulty) {
    for (const name of employee.fails) {
      test(
        `${name} rejects ${employee.name}`,
        async () => {
          const outcome = await behaviours[name](employee.dir);
          expect(outcome.ok).toBe(false);
        },
        TIMEOUT,
      );
    }
  }
});

test("every behaviour check has at least one faulty employee that it rejects", () => {
  const covered = new Set(faulty.flatMap((employee) => employee.fails));
  for (const name of behaviourNames) expect(covered.has(name)).toBe(true);
});

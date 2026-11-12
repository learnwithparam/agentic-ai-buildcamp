// The checks check themselves: every behaviour check passes on the reference employee and fails on each
// planted-fault employee in tests/faulty/ that targets it.
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { behaviours, type BehaviourName } from "../checks/lib/behaviours";

const ROOT = join(import.meta.dir, "..");
const FAULTY = join(import.meta.dir, "faulty");
const faulty = readdirSync(FAULTY).map((name) => ({
  name,
  dir: join(FAULTY, name),
  fails: (Bun.TOML.parse(readFileSync(join(FAULTY, name, "employee.toml"), "utf8")) as any).fails as BehaviourName[],
}));
const TIMEOUT = 90_000;

describe("the reference passes every behaviour check", () => {
  for (const name of Object.keys(behaviours) as BehaviourName[])
    test(name, async () => {
      const r = await behaviours[name](join(ROOT, "reference"));
      expect(r.message).toBe(`3 of 3 fresh trials passed.`);
      expect(r.ok).toBe(true);
    }, TIMEOUT);
});

describe("each faulty employee fails the checks it targets", () => {
  for (const f of faulty)
    for (const name of f.fails)
      test(`${name} rejects ${f.name}`, async () => {
        const r = await behaviours[name](f.dir);
        expect(r.ok).toBe(false);
      }, TIMEOUT);
});

test("every behaviour check has at least one faulty employee that it rejects", () => {
  const covered = new Set(faulty.flatMap((f) => f.fails));
  for (const name of Object.keys(behaviours)) expect(covered.has(name as BehaviourName)).toBe(true);
});

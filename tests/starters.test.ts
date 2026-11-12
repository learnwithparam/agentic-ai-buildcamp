// The starter kits pass answer-the-contract and the first job step out of the box, and nothing after.
// The Python starter is checked through the contract like any learner's employee; it runs only where uv is installed.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BehaviourName, behaviours } from "../checks/lib/behaviours";

const ROOT = join(import.meta.dir, "..");
const PASS: BehaviourName[] = ["answer-the-contract", "call-the-tools"];
const all = Object.keys(behaviours) as BehaviourName[];

describe("starter/typescript", () => {
  const dir = join(ROOT, "starter", "typescript");
  for (const name of all)
    test(`${PASS.includes(name) ? "passes" : "fails"} ${name}`, async () => {
      expect((await behaviours[name](dir)).ok).toBe(PASS.includes(name));
    }, 90_000);
});

describe.skipIf(!Bun.which("uv"))("starter/python", () => {
  const dir = join(ROOT, "starter", "python");
  // Keep uv's virtual environment out of the repo, so the standard check never walks into it.
  process.env.UV_PROJECT_ENVIRONMENT ??= mkdtempSync(join(tmpdir(), "buildcamp-venv-"));
  for (const name of [...PASS, "pay-one-invoice"] as BehaviourName[])
    test(`${PASS.includes(name) ? "passes" : "fails"} ${name}`, async () => {
      expect((await behaviours[name](dir)).ok).toBe(PASS.includes(name));
    }, 120_000);
});

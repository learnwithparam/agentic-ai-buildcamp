// Two proofs that a script cannot crash into a pass. No model call, no service.
// 1. Structural: every script that defines main() starts it through runMain.
// 2. Behavioral: a tiny script that throws, started through the helper, exits non-zero.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { didNotFinishMessage, runMain } from "./run-main";

const here = path.dirname(fileURLToPath(import.meta.url));

/** Entry points that define main() but do not start it through runMain. Empty on purpose. */
export function entryPointProblems(file: string, source: string): string[] {
  if (!/^(async )?function main\(/m.test(source)) return [];
  const problems: string[] = [];
  if (!/\bvoid runMain\(main,/.test(source) || !/from "\.\/run-main"/.test(source)) problems.push(`${file}: starts main without runMain from ./run-main`);
  if (/^\s*(if \(.*\) )?(void |await )?main\(\)/m.test(source) || /\bmain\(\)\.catch\(/.test(source)) problems.push(`${file}: calls main() directly (void, await or .catch)`);
  return problems;
}

test("every script entry point starts main through runMain", () => {
  const files = readdirSync(here).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && !name.endsWith(".live.ts") && name !== "run-main.ts");
  const problems = files.flatMap((name) => entryPointProblems(`scripts/${name}`, readFileSync(path.join(here, name), "utf8")));
  assert.deepEqual(problems, []);
});

test("the structural check catches the old shapes", () => {
  const old = 'async function main() {}\nvoid main();\n';
  assert.equal(entryPointProblems("a.ts", old).length, 2);
  assert.equal(entryPointProblems("a.ts", 'async function main() {}\nif (x) await main();\n').length, 2);
  assert.equal(entryPointProblems("a.ts", 'async function main() {}\nmain().catch(() => {});\n').length, 2);
  assert.deepEqual(entryPointProblems("a.ts", 'import { runMain } from "./run-main";\nasync function main() {}\nvoid runMain(main, { name: "A" });\n'), []);
});

test("runMain exits 1 and says the run did not finish when main throws", async () => {
  const lines: string[] = [];
  const codes: number[] = [];
  await runMain(async () => { throw new Error("Langfuse score write timed out"); }, { name: "Release gate", exit: (code) => codes.push(code), log: (line) => lines.push(line) });
  assert.deepEqual(codes, [1]);
  assert.match(lines[0], /Release gate: did not finish/);
  assert.match(lines[0], /NOT a pass/);
  assert.match(lines[0], /timed out/);
  assert.doesNotMatch(didNotFinishMessage("Gate", new Error("x")), /green/i);
});

test("runMain leaves a clean run and a clean verdict alone", async () => {
  const codes: number[] = [];
  await runMain(async () => undefined, { name: "A", exit: (code) => codes.push(code) });
  assert.deepEqual(codes, []);
});

test("a real script that throws through runMain exits non-zero", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "run-main-"));
  const script = path.join(dir, "tiny.ts");
  writeFileSync(script, `import { runMain } from ${JSON.stringify(path.join(here, "run-main.ts"))};\nasync function main() { await Promise.reject(new Error("boom")); }\nvoid runMain(main, { name: "Tiny" });\n`);
  const result = spawnSync(process.execPath, ["--import", "tsx", script], { encoding: "utf8", cwd: path.join(here, "..") });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tiny: did not finish/);
});

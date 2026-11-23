// bun run mutate
//
// A test that never fails proves nothing. This breaks one rule in each unit on purpose.
// It runs that unit's promise test and needs the test to fail. Then it puts the file back.
// The breaks live in content/<slug>.ts, so each unit owns its own list.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Break } from "../src/content";
import { stemFor } from "../src/workshop";
import { ROOT } from "./root";
import { builtUnits } from "./units";

export type Verdict = "caught" | "missed" | "not-found";

// Swap the text, run the test, and always put the file back, even when the test run throws.
export function tryBreak(file: string, change: Break, testPasses: () => boolean): Verdict {
  const original = readFileSync(file, "utf8");
  if (!original.includes(change.find)) return "not-found";
  writeFileSync(file, original.replace(change.find, change.replace));
  try {
    return testPasses() ? "missed" : "caught";
  } finally {
    writeFileSync(file, original);
  }
}

function promiseTestPasses(stem: string): boolean {
  const test = join("tests", "promises", `${stem}.test.ts`);
  const run = Bun.spawnSync(["bun", "test", "--timeout", "60000", test], {
    cwd: ROOT,
    stdout: "ignore",
    stderr: "ignore",
  });
  return run.exitCode === 0;
}

if (import.meta.main) {
  let bad = 0;
  for (const { unit, content } of await builtUnits()) {
    if (content.breaks.length === 0) {
      console.error(`${unit.slug}: no planted bugs. Every built unit needs at least one.`);
      bad += 1;
    }
    for (const change of content.breaks) {
      const stem = stemFor(unit);
      const verdict = tryBreak(join(ROOT, change.file), change, () => promiseTestPasses(stem));
      if (verdict !== "caught") bad += 1;
      console.log(`${verdict.padEnd(9)} ${unit.slug}: ${change.rule}`);
    }
  }
  if (bad > 0) {
    console.error(`${bad} broken rules were not caught by a promise test.`);
    process.exit(1);
  }
  console.log("Every promise test fails when its rule is broken.");
}

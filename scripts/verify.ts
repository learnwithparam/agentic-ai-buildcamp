// bun run verify <name>: run the checks for one module or lab.
// Each check runs from a fresh start several times and passes only when every run passes.
// A failing check prints a "Try next:" line. The command exits 1 when any check fails.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { badge, box } from "../src/ui";
import { type Check, passEvery } from "../src/verify";
import { unitBySlug } from "../src/workshop";
import { ROOT } from "./root";

async function checksFor(slug: string): Promise<Check[]> {
  const file = join(ROOT, "checks", `${slug}.ts`);
  if (!existsSync(file)) {
    console.error(`There is no checks/${slug}.ts yet.`);
    process.exit(2);
  }
  const module = (await import(file)) as { checks: Check[] };
  return module.checks;
}

async function main(): Promise<void> {
  const unit = unitBySlug(process.argv[2] ?? "");
  if (unit === undefined) {
    console.error("Say which module or lab, for example: bun run verify foundation");
    process.exit(2);
  }
  console.log(box(unit.title));
  let failed = 0;
  for (const check of await checksFor(unit.slug)) {
    const outcome = await passEvery(check);
    console.log(`${badge(outcome.ok)}  ${outcome.name}: ${outcome.message}`);
    if (!outcome.ok) {
      failed += 1;
      console.log(`      Try next: ${outcome.tryNext}`);
    }
  }
  if (failed > 0) process.exit(1);
  console.log("Every check passed.");
}

await main();

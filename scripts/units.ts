// Shared loading for the course checks: each built unit with its content, page and check file.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { UnitContent } from "../src/content";
import { pageFor, UNITS, type Unit } from "../src/workshop";
import { ROOT } from "./root";

export type Loaded = { unit: Unit; content: UnitContent; page: string };

export function readIfThere(relative: string): string {
  const full = join(ROOT, relative);
  return existsSync(full) ? readFileSync(full, "utf8") : "";
}

// Every unit marked built. A unit with no content file is a problem the course test reports.
export async function builtUnits(): Promise<Loaded[]> {
  const loaded: Loaded[] = [];
  for (const unit of UNITS.filter((item) => item.built)) {
    const module = (await import(join(ROOT, "content", `${unit.slug}.ts`))) as {
      content: UnitContent;
    };
    loaded.push({ unit, content: module.content, page: readIfThere(pageFor(unit)) });
  }
  return loaded;
}

// Print every problem, then exit 1 when there are any. Each check ends the same way.
export function finish(problems: string[], goodNews: string, badNews: string): void {
  for (const problem of problems) console.error(problem);
  if (problems.length > 0) {
    console.error(`${problems.length} ${badNews}`);
    process.exit(1);
  }
  console.log(goodNews);
}

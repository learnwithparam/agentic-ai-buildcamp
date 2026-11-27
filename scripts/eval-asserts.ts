/**
 * Every assert in data/hcp/evals/*.yaml, read from the file as written (not through the case
 * loader), so a check the loader would skip still shows. A type no runner handles is a problem.
 * scripts/eval-asserts.test.ts walks the directory; hcp-cases.ts stops the load on the same list.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { EVALS_DIR, HANDLED_ASSERTS } from "./hcp-cases";

type Raw = { defaultTest?: { assert?: Array<{ type?: string }> }; tests?: Array<{ description?: string; assert?: Array<{ type?: string }> }> };

export type AssertCount = { file: string; type: string; count: number };

// Every assert type in a file with how often it appears, defaults counted once per test that inherits them.
export function assertTypes(file: string, text: string): AssertCount[] {
  const config = (parse(text) ?? {}) as Raw;
  const counts = new Map<string, number>();
  for (const test of config.tests ?? []) {
    for (const check of [...(config.defaultTest?.assert ?? []), ...(test.assert ?? [])]) {
      const type = check.type ?? "(no type)";
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
  }
  return [...counts].map(([type, count]) => ({ file, type, count }));
}

export function unhandledAsserts(dir = EVALS_DIR): string[] {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .flatMap((name) => assertTypes(name, readFileSync(path.join(dir, name), "utf8")))
    .filter(({ type }) => !HANDLED_ASSERTS.includes(type))
    .map(({ file, type, count }) => `${file}: ${count} assert(s) of type "${type}" that no runner handles`);
}

// How many llm-rubric asserts the files hold, one per test that carries one (a default would count per test).
export function rubricCount(dir = EVALS_DIR): number {
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .flatMap((name) => assertTypes(name, readFileSync(path.join(dir, name), "utf8")))
    .filter(({ type }) => type === "llm-rubric")
    .reduce((sum, { count }) => sum + count, 0);
}

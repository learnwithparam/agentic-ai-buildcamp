import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

// docs/learner/data.md and evals.md are the guides to data/hcp. A new data folder or a new assert
// type in the cases fails here until the guide explains it.
const root = path.resolve(import.meta.dirname, "..");
const hcp = path.join(root, "data/hcp");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");

test("every data/hcp folder has a row in docs/learner/data.md", () => {
  const page = read("docs/learner/data.md");
  const folders = readdirSync(hcp).filter((name) => statSync(path.join(hcp, name)).isDirectory());
  assert.ok(folders.length > 0);
  for (const folder of folders) assert.match(page, new RegExp(`^\\| \`${folder}\` \\|`, "m"), `data.md has no row for data/hcp/${folder}`);
});

test("every assert type and every eval file is explained in docs/learner/evals.md", () => {
  const page = read("docs/learner/evals.md");
  const files = readdirSync(path.join(hcp, "evals")).filter((name) => name.endsWith(".yaml"));
  const types = new Set(files.flatMap((file) => [...readFileSync(path.join(hcp, "evals", file), "utf8").matchAll(/type: ([a-z-]+)/g)].map((match) => match[1]!)));
  assert.ok(types.size > 0);
  for (const type of types) assert.match(page, new RegExp(`^\\| \`${type}\` \\|`, "m"), `evals.md has no row for the assert type ${type}`);
  for (const file of files) assert.ok(page.includes(`\`${file}\``), `evals.md does not name ${file}`);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { findProblems } from "./check-repo";

const base: Record<string, string> = {
  "README.md": "You need Node `>=22.18.0`.\n\n![app](docs/images/sample_app.png)\n\nRead [the brief](case-studies/brief.md).\n\n```bash\nnpm run seed\n```\n",
  "package.json": JSON.stringify({ engines: { node: ">=22.18.0" }, scripts: { dev: "vite", seed: "tsx scripts/seed.ts" } }),
  "scripts/seed.ts": "import { load } from './lib';\nconst file = resolve(\"../data/items.json\");\n",
  "scripts/lib.ts": "export const load = 1;\n",
  "data/items.json": "[]",
  "docs/images/sample_app.png": "",
  "case-studies/brief.md": "A brief.\n",
};

function run(changes: Record<string, string | null>): string[] {
  const all = { ...base, ...changes };
  const files = new Map(Object.entries(all).filter((entry): entry is [string, string] => entry[1] !== null));
  return findProblems(files, [...files.keys()]);
}

test("a repo where everything is used passes", () => {
  assert.deepEqual(run({}), []);
});

test("an image is not used because a longer name contains its name", () => {
  assert.match(run({ "docs/images/app.png": "" }).join("\n"), /docs\/images\/app\.png/);
});

test("a script named only in a comment is unused", () => {
  const problems = run({ "scripts/dead.ts": "", "scripts/lib.ts": "// replaced dead.ts\nexport const load = 1;\n" });
  assert.match(problems.join("\n"), /scripts\/dead\.ts/);
});

test("a data file named only in prose is unused", () => {
  const problems = run({ "data/orphan.json": "[]", "case-studies/brief.md": "See data/orphan.json.\n" });
  assert.match(problems.join("\n"), /data\/orphan\.json/);
});

test("a file used only by an unused file is unused", () => {
  const problems = run({ "scripts/dead.ts": "import { x } from './helper';\n", "scripts/helper.ts": "export const x = 1;\n" });
  assert.match(problems.join("\n"), /scripts\/helper\.ts/);
});

test("an npm script named only in a sentence is unused", () => {
  const problems = run({
    "package.json": JSON.stringify({ engines: { node: ">=22.18.0" }, scripts: { seed: "tsx scripts/seed.ts", foo: "echo" } }),
    "README.md": base["README.md"] + "\nDo not npm run foo ever.\n",
  });
  assert.match(problems.join("\n"), /"foo"/);
});

test("code that names a missing repo path fails", () => {
  const problems = run({ "scripts/lib.ts": "spawn('tsx', ['scripts/gone.ts']);\nexport const load = 1;\n" });
  assert.match(problems.join("\n"), /names scripts\/gone\.ts, which does not exist/);
});

test("a single quoted import counts as use", () => {
  assert.deepEqual(run({}).filter((problem) => problem.includes("lib.ts")), []);
});

test("a dependency without an exact version fails", () => {
  const problems = run({
    "package.json": JSON.stringify({ engines: { node: ">=22.18.0" }, scripts: { seed: "tsx scripts/seed.ts" }, dependencies: { a: "latest", b: "^1.2.3", c: "1.2.3" } }),
  });
  assert.match(problems.join("\n"), /"a" is "latest"/);
  assert.match(problems.join("\n"), /"b" is "\^1\.2\.3"/);
  assert.doesNotMatch(problems.join("\n"), /"c"/);
});

test("a README that names a different Node version fails", () => {
  const problems = run({ "README.md": base["README.md"].replace(">=22.18.0", ">=20") });
  assert.match(problems.join("\n"), /README\.md: does not name the Node version/);
});

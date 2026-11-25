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

test("an npm lifecycle script needs no doc, because npm install runs it", () => {
  const problems = run({
    "package.json": JSON.stringify({ engines: { node: ">=22.18.0" }, scripts: { seed: "tsx scripts/seed.ts", prepare: "git config core.hooksPath .githooks" } }),
  });
  assert.doesNotMatch(problems.join("\n"), /"prepare"/);
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

test("a component that still names the upstream app fails", () => {
  const problems = run({ "src/client/App.tsx": "export const PhonePanel = () => null;\n" });
  assert.match(problems.join("\n"), /App\.tsx: still names PhonePanel/);
});

test("a colour written outside tokens.css fails, and inside it passes", () => {
  const problems = run({
    "src/client/styles/tokens.css": ":root { --fg: #151515; }\n",
    "src/client/styles/app.css": ".box { color: #ff0000; }\n",
    "src/client/App.tsx": '<div className="box" />\n',
  });
  assert.match(problems.join("\n"), /app\.css: writes the colour #ff0000/);
  assert.doesNotMatch(problems.join("\n"), /tokens\.css: writes/);
});

test("a CSS class no component uses fails", () => {
  const problems = run({
    "src/client/styles/app.css": ".card { padding: 0; }\n.card-head { gap: 0; }\n",
    "src/client/App.tsx": '<div className="card" />\n',
  });
  assert.match(problems.join("\n"), /class \.card-head is not used/);
  assert.doesNotMatch(problems.join("\n"), /class \.card is not used/);
});

test("coverage fails on an empty row, an unknown case and an uncovered case", () => {
  const cases = '  - description: "[STALENESS-01] x"\n  - description: "[COUNTRY-01] y"\n';
  const table = "| Promise | Chapter | Cases |\n|---|---|---|\n";
  const passing = run({ "data/hcp/evals/medinfo.yaml": cases, "docs/coverage.md": table + "| Fresh | 07 | STALENESS-01, COUNTRY-01 |\n" });
  assert.deepEqual(passing.filter((problem) => problem.startsWith("docs/coverage.md")), []);
  const problems = run({
    "data/hcp/evals/medinfo.yaml": cases,
    "docs/coverage.md": table + "| Fresh | 07 | STALENESS-01, GHOST-09 |\n| Empty | 11 |  |\n",
  }).join("\n");
  assert.match(problems, /"Empty" has no case/);
  assert.match(problems, /GHOST-09 is not a case/);
  assert.match(problems, /case COUNTRY-01 is in no row/);
});

test("a README that names a different Node version fails", () => {
  const problems = run({ "README.md": base["README.md"].replace(">=22.18.0", ">=20") });
  assert.match(problems.join("\n"), /README\.md: does not name the Node version/);
});

test("a test is in use when the check script's glob covers its folder, and only then", () => {
  const pkg = JSON.stringify({ engines: { node: ">=22.18.0" }, scripts: { dev: "vite", seed: "tsx scripts/seed.ts", check: "tsx --test 'scripts/**/*.test.ts'" } });
  const problems = run({ "package.json": pkg, "scripts/lib.test.ts": "", "README.md": base["README.md"] + "\n`npm run check`\n" }).join("\n");
  assert.doesNotMatch(problems, /scripts\/lib\.test\.ts/);
  assert.match(run({ "scripts/lib.test.ts": "" }).join("\n"), /scripts\/lib\.test\.ts/);
});

test("an import by repo path, from another folder, counts as use", () => {
  const changes = { "scripts/guard.ts": "export const guard = 1;\n", "scripts/seed.ts": 'import { load } from "./lib";\nimport { guard } from "../scripts/guard";\nconst file = resolve("../data/items.json");\n' };
  assert.deepEqual(run(changes), []);
  assert.deepEqual(run({ ...changes, "scripts/seed.ts": base["scripts/seed.ts"] }), ["scripts/guard.ts: nothing in use reads, links or calls it. Use it or delete it."]);
});

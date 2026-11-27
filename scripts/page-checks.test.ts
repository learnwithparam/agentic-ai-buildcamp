import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { glossaryProblems } from "./glossary";
import { readmeProblems, shapeProblems } from "./lesson-shape";
import { declaredStates, diagramProblems } from "./mermaid";
import { problemsIn, teachProblems } from "./plain-english";

// Each page check is fed one bad page and must fail on it, so a check that stops biting is red.
// The pages here are small, made-up lessons; the real pages run in CI with `npm run check:pages`.

const fence = "```";
const lesson = (parts: Partial<Record<string, string>> = {}) =>
  [
    "# Check every citation",
    "## The problem", parts.problem ?? "A doctor reads a dose that was never approved.",
    "## What you build", "A check.",
    "## How it works", "The idea.",
    "### The flow", parts.flow ?? `${fence}mermaid\nsequenceDiagram\n  A->>B: ask\n  B-->>A: refused\n${fence}`,
    "### Where it sits", `${fence}mermaid\nflowchart LR\n  a --> b\n${fence}`,
    ...(parts.states ? ["### The states", parts.states] : []),
    "### Concepts", parts.concepts ?? "- [Citation](../walkthrough.md#c-citation)\n- [Held answer](../walkthrough.md#c-held-answer)",
    "## Build it", "```bash\ngit checkout checkpoint/21-citations\n```",
    parts.add ?? "You add these files.\n\n- `src/server/citations.ts`: the check itself.",
    "### Step 1", "Run it. Each citation and each held answer shows.",
    "### Check your build", "```bash\nnpm run check\ngit diff --stat checkpoint/22-insights\n```",
    "## Prove it", "Cases.",
    "## Stuck points", "None.",
    "## What to watch for", "Drift.",
    "## Results", "A row.",
    "## Where to go next", "Code."
  ].join("\n\n");

const FILE = "docs/learner/21-citations.md";
const noCode = () => null;

test("a page in the shape passes the shape check", () => {
  assert.deepEqual(shapeProblems(FILE, lesson()), []);
});

test("the shape check fails a missing heading, a wrong order and a product in The problem", () => {
  assert.match(shapeProblems(FILE, lesson().replace("## Stuck points\n\nNone.\n\n", "")).join("\n"), /missing "## Stuck points"/);
  const swapped = lesson().replace("## Results", "## TMP").replace("## What to watch for", "## Results").replace("## TMP", "## What to watch for");
  assert.match(shapeProblems(FILE, swapped).join("\n"), /out of order/);
  assert.match(shapeProblems(FILE, lesson({ problem: "Langfuse shows the trace." })).join("\n"), /"The problem" names Langfuse/);
  assert.match(shapeProblems(FILE, lesson().replace("# Check every citation", "# Check citations in Langfuse")).join("\n"), /names Langfuse/);
});

test("a build page fails when its tag already holds a file it says you add, or the end of the build is missing", () => {
  const already = lesson({ add: "You add these files.\n\n- `src/server/auth.ts`: the sign-in." });
  assert.match(shapeProblems(FILE, already).join("\n"), /tag 21 already holds src\/server\/auth.ts/);
  assert.match(shapeProblems(FILE, lesson({ add: "You add these files.\n\n- `src/server/not-a-file.ts`: nothing." })).join("\n"), /names src\/server\/not-a-file.ts/);
  assert.match(shapeProblems(FILE, lesson({ add: "No list." })).join("\n"), /needs a line "You add"/);
  assert.match(shapeProblems(FILE, lesson().replace("npm run check\n", "")).join("\n"), /run npm run check/);
  assert.match(shapeProblems(FILE, lesson().replace(/git diff --stat \S+/, "git diff")).join("\n"), /compare with the next tag/);
});

test("a title that starts with a number fails: the file name carries it", () => {
  assert.match(shapeProblems(FILE, lesson().replace("# Check every citation", "# 21 Check every citation")).join("\n"), /starts with a number/);
  assert.deepEqual(shapeProblems(FILE, lesson()), []);
});

test("the README links each lesson once, by the page's own title", () => {
  const pages = [{ file: FILE, page: lesson() }];
  assert.deepEqual(readmeProblems("| 21 | [Check every citation](./docs/learner/21-citations.md) |", pages), []);
  assert.match(readmeProblems("| 21 | [Citations](./docs/learner/21-citations.md) |", pages).join("\n"), /its title is "Check every citation"/);
  assert.match(readmeProblems("No table.", pages).join("\n"), /links docs\/learner\/21-citations.md 0 times/);
});

test("the diagram check fails a happy-path sequence and a missing flow diagram", () => {
  assert.deepEqual(diagramProblems(FILE, lesson(), noCode, true), []);
  const happy = lesson({ flow: `${fence}mermaid\nsequenceDiagram\n  A->>B: ask\n  B-->>A: answer\n${fence}` });
  assert.match(diagramProblems(FILE, happy, noCode, true).join("\n"), /only the happy path/);
  assert.match(diagramProblems(FILE, lesson({ flow: "No picture." }), noCode, true).join("\n"), /needs a sequence diagram/);
});

test("a state diagram must draw exactly the states its source declares", () => {
  const code = 'export type CitationOutcome = { outcome: "passed" | "rewritten" | "withheld" };\n';
  assert.deepEqual(declaredStates(code, "CitationOutcome"), ["passed", "rewritten", "withheld"]);
  const states = (body: string) => lesson({ states: `${fence}mermaid\nstateDiagram-v2\n  %% states: src/server/graph.ts CitationOutcome\n${body}\n${fence}` });
  const read = () => code;
  assert.deepEqual(diagramProblems(FILE, states("  [*] --> passed\n  [*] --> rewritten\n  rewritten --> withheld"), read, true), []);
  assert.match(diagramProblems(FILE, states("  [*] --> passed\n  [*] --> rewritten"), read, true).join("\n"), /misses "withheld"/);
  assert.match(diagramProblems(FILE, states("  [*] --> passed\n  [*] --> rewritten\n  rewritten --> withheld\n  withheld --> retried"), read, true).join("\n"), /draws "retried"/);
  assert.match(diagramProblems(FILE, states("  [*] --> passed"), noCode, true).join("\n"), /does not exist/);
});

const walkthrough = (meaning = "A pointer from a fact to where it came from. A doctor can check it.") =>
  ["### Concepts", '<a id="c-citation"></a>', `**Citation.** ${meaning}`, "", '<a id="c-held-answer"></a>', "**Held answer.** A fixed reply sent instead. It tells the doctor to ask a person."].join("\n");

test("the glossary check passes a defined, linked, used word and fails each rule", () => {
  assert.deepEqual(glossaryProblems(walkthrough(), [{ file: FILE, page: lesson() }]), []);
  const missing = lesson({ concepts: "- [Citation](../walkthrough.md#c-citation)\n- [Nope](../walkthrough.md#c-nope)" });
  assert.match(glossaryProblems(walkthrough(), [{ file: FILE, page: missing }]).join("\n"), /G1 .*c-nope/);
  assert.match(glossaryProblems(walkthrough(), [{ file: FILE, page: missing }]).join("\n"), /G2 "Held answer"/);
  const long = "It is a pointer that goes from each fact in the answer all the way back to the place it came from in the label.";
  assert.match(glossaryProblems(walkthrough(long), [{ file: FILE, page: lesson() }]).join("\n"), /G4 "Citation"/);
  const unused = lesson().replace("Each citation and each held answer shows.", "It shows.");
  assert.match(glossaryProblems(walkthrough(), [{ file: FILE, page: unused }]).join("\n"), /G6 .*"Held answer"/);
  const one = lesson({ concepts: "- [Citation](../walkthrough.md#c-citation)" });
  assert.match(glossaryProblems(walkthrough(), [{ file: FILE, page: one }]).join("\n"), /G5 .*links 1 words/);
});

test("the prose check fails a long sentence and reads past front matter", () => {
  const long = "This sentence keeps on going with far more words than any reader at the desk would like to read in one go.";
  assert.ok(problemsIn(FILE, `${long}\n`, 6).some((problem) => /word sentence/.test(problem.message)));
  assert.deepEqual(problemsIn(FILE, '---\ntitle: "Workshop: A Very Long Title That Is Only Metadata For The Site Listing Page"\n---\nA short line.\n', 6), []);
});

// CI runs check:pages (.github/workflows/check.yml). It is not in `npm run check`, because the tag
// sync runs that on every tag, and a state diagram names code an early tag does not have yet.
// A tag carries no .github folder and keeps its own package.json, so this holds on main only.
test("CI runs check:pages, and check:pages runs every page check", (t) => {
  if (!existsSync(".github/workflows/check.yml")) return t.skip("a checkpoint tag has no CI");
  assert.match(readFileSync(".github/workflows/check.yml", "utf8"), /run: npm run check:pages/);
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  for (const check of ["plain-english", "lesson-shape", "glossary", "mermaid", "page-numbers"]) assert.match(scripts["check:pages"] ?? "", new RegExp(`scripts/${check}\\.ts`));
});

test("the prose check does not read a from-comment as words or sentences", () => {
  const cite = (n: number, key: string) => `${n}<!-- from: docs/runs/search.json#configs.graded.all.${key} -->`;
  const para = `Fusion alone barely moves the averages. It finds some exact words. The grader does the work. It lifts recall from ${cite(0.749 as never, "a")} to ${cite(0.952 as never, "b")}. It turns nothing into ${cite(0.95 as never, "c")}.\n`;
  assert.deepEqual(problemsIn(FILE, para, 6), []);
  assert.deepEqual(teachProblems(FILE, para, 6), []);
  assert.deepEqual(problemsIn(FILE, "| Row | Result |\n| --- | --- |\n| 07 | 22/28 | <!-- from-row: docs/runs/scoreboard-07.json -->\n", 6), []);
});

test("every `npm run` a page names is a script in package.json", (t) => {
  if (!existsSync("docs/learner")) return t.skip("no lessons here");
  // A checkpoint tag holds main's copy of every page (lesson-files.json versions none of them), but
  // only the scripts its lessons have reached, so page 18 on tag 05 names scripts that come later.
  // Main checks the same text against every script.
  if (!existsSync("scripts/sync-checkpoints.sh")) return t.skip("pages are main's copy; checked on main");
  const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
  const pages = ["README.md", "docs/walkthrough.md", ...readdirSync("docs/learner", { recursive: true, encoding: "utf8" }).filter((name) => name.endsWith(".md")).map((name) => `docs/learner/${name}`)];
  for (const file of pages) {
    for (const [, name] of readFileSync(file, "utf8").matchAll(/npm run ([a-z][\w:-]*)/g)) assert.ok(name in scripts, `${file} names npm run ${name}, which package.json lacks`);
  }
});

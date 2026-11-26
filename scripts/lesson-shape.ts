// Every lesson page tells one story in the same order: the problem, what you build, how it works,
// then the build. Many readers stop after "How it works", so that part must come first and must
// not read like a tool tour. A product is named by its job inside the page, never in the title,
// a heading or "The problem".
import { readdirSync, readFileSync } from "node:fs";
import { expand, holds, loadManifest, versionsOf, youAdd } from "./lesson-tags";
import { withoutFrontMatter } from "./plain-english";

export const LESSONS = "docs/learner";

// The headings, in order. "### The states" is the one a lesson may leave out: not every lesson
// has a thing that moves between states.
export const SHAPE: Array<{ heading: string; optional?: true }> = [
  { heading: "## The problem" },
  { heading: "## What you build" },
  { heading: "## How it works" },
  { heading: "### The flow" },
  { heading: "### Where it sits" },
  { heading: "### The states", optional: true },
  { heading: "### Concepts" },
  { heading: "## Build it" },
  { heading: "## Prove it" },
  { heading: "## Stuck points" },
  { heading: "## What to watch for" },
  { heading: "## Results" },
  { heading: "## Where to go next" }
];

// The products the course runs. A page names them in the build, by their job. Matched with case,
// so "react" the verb is fine. Open protocols (MCP, A2A, OAuth) are ideas a lesson teaches, not
// products, so a title may name them.
export const PRODUCTS = [
  "Langfuse", "LangGraph", "LangChain", "Postgres", "PostgreSQL", "pgvector", "Keycloak", "OpenFGA",
  "PDF.js", "OpenRouter", "OpenAI", "Docker", "React", "Vite", "assistant-ui", "Claude"
];

const h2Or3 = /^#{2,3} /;

// The section under a heading, up to the next heading of the same or a higher level.
export function sectionOf(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start < 0) return "";
  const level = heading.split(" ")[0].length;
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && line.split(" ")[0].length <= level);
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

// Headings outside code blocks: a "## Heading" inside a fenced Markdown sample is not one.
export function headingsOf(markdown: string): string[] {
  let inFence = false;
  const found: string[] = [];
  for (const line of markdown.split("\n")) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    else if (!inFence && /^#{1,3} /.test(line)) found.push(line.trim());
  }
  return found;
}

const named = (text: string, product: string) =>
  new RegExp(`(^|[^\\w-])${product.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`).test(text);

export function shapeProblems(file: string, page: string): string[] {
  const markdown = withoutFrontMatter(page);
  const problems: string[] = [];
  const headings = headingsOf(markdown);
  const number = file.match(/(\d\d)-[^/]*\.md$/)?.[1];
  const title = headings[0] ?? "";
  // The file name and the README's Step column carry the number; the title is only what the reader can do.
  if (!number || !/^# \S/.test(title)) problems.push(`${file}: the first heading must be "# <what the reader can do>"`);
  else if (/^# \d/.test(title)) problems.push(`${file}: the title starts with a number; the file name carries it`);

  // The shape's headings must appear in order. Others (### Step 1, ...) may sit between them.
  const shaped = headings.filter((line) => SHAPE.some((part) => part.heading === line));
  const expected = SHAPE.filter((part) => !part.optional || shaped.includes(part.heading)).map((part) => part.heading);
  for (const part of SHAPE) {
    if (!part.optional && !headings.includes(part.heading)) problems.push(`${file}: missing "${part.heading}"`);
  }
  if (shaped.join("|") !== expected.filter((heading) => shaped.includes(heading)).join("|")) {
    problems.push(`${file}: headings out of order; the order is ${SHAPE.map((part) => part.heading.replace(/^#+ /, "")).join(", ")}`);
  }
  if (new Set(shaped).size !== shaped.length) problems.push(`${file}: a shape heading appears twice`);

  // Steps live under "Build it".
  const build = sectionOf(markdown, "## Build it");
  for (const heading of headings.filter((line) => /^##+ Step \d/.test(line))) {
    if (!heading.startsWith("### ") || !build.includes(heading)) problems.push(`${file}: "${heading}" must be a ### heading under "## Build it"`);
  }
  // The build starts from the lesson's checkpoint.
  if (number && !/git checkout checkpoint\/\d\d-/.test(build)) problems.push(`${file}: "## Build it" must start with git checkout of the lesson's checkpoint`);

  // From lesson 10 each page is a build: start from the lesson's own tag, add the named files,
  // run the check, compare with the next tag.
  if (number && Number(number) >= 10) problems.push(...buildProblems(file, Number(number), build, markdown));

  for (const product of PRODUCTS) {
    for (const heading of headings.filter((line) => h2Or3.test(line) || line.startsWith("# "))) {
      if (named(heading, product)) problems.push(`${file}: heading "${heading}" names ${product}; name the job, not the product`);
    }
    if (named(sectionOf(markdown, "## The problem"), product)) problems.push(`${file}: "The problem" names ${product}; tell the problem, the product comes in the build`);
  }
  return problems;
}

// The tag is the start of the lesson, so the files the page says you add must not be on it, and
// must be on the next tag, which is where the lesson ends.
export function buildProblems(file: string, lesson: number, build: string, markdown: string, manifest = loadManifest()): string[] {
  const problems: string[] = [];
  const named = youAdd(markdown);
  if (named.length === 0) problems.push(`${file}: "## Build it" needs a line "You add" (or "You change") and one bullet per file the lesson adds`);
  for (const name of named) {
    const files = expand(manifest, name, lesson);
    if (!(name in manifest.files) && files.length === 0) problems.push(`${file}: "You add" names ${name}, which this lesson adds or changes nothing under`);
    for (const path of files) {
      const entry = manifest.files[path];
      if (!versionsOf(entry).includes(lesson)) {
        problems.push(
          holds(entry, lesson)
            ? `${file}: tag ${lesson} already holds ${path}, so the page cannot ask you to add it`
            : `${file}: ${path} is not added or changed by lesson ${lesson} (lessons ${versionsOf(entry).join(", ") || "none"})`
        );
      }
    }
  }
  if (!/^npm run check$/m.test(build)) problems.push(`${file}: "## Build it" must tell the reader to run npm run check`);
  if (!/^git diff --stat (checkpoint\/\d\d-\S+|main)$/m.test(build)) problems.push(`${file}: "## Build it" must compare with the next tag: git diff --stat checkpoint/<next>`);
  return problems;
}

// The README's lesson table is the one list of lessons. Each lesson is linked once, by its title
// as the page's own first heading gives it, so a renamed page cannot leave an old title behind.
export function readmeProblems(readme: string, pages: Array<{ file: string; page: string }>): string[] {
  const problems: string[] = [];
  for (const { file, page } of pages) {
    const title = headingsOf(withoutFrontMatter(page))[0]?.replace(/^# /, "") ?? "";
    const links = [...readme.matchAll(new RegExp(`\\[([^\\]]+)\\]\\(\\./${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)`, "g"))];
    if (links.length !== 1) problems.push(`README.md: links ${file} ${links.length} times; link it once in the lesson table`);
    else if (links[0][1] !== title) problems.push(`README.md: ${file} is linked as "${links[0][1]}", but its title is "${title}"`);
  }
  return problems;
}

export function lessonFiles(): string[] {
  return readdirSync(LESSONS).filter((name) => /^\d\d-.*\.md$/.test(name)).sort().map((name) => `${LESSONS}/${name}`);
}

if (import.meta.main) {
  const pages = lessonFiles().map((file) => ({ file, page: readFileSync(file, "utf8") }));
  const problems = [...pages.flatMap(({ file, page }) => shapeProblems(file, page)), ...readmeProblems(readFileSync("README.md", "utf8"), pages)];
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} lesson shape problems.`);
    process.exit(1);
  }
  console.log(`Every lesson page has the shape: ${lessonFiles().length} pages.`);
}

// Every diagram on a lesson page and in docs/walkthrough.md must render, and must show what the
// code does. Rules:
//   a page's "The flow" holds a sequence diagram, and "Where it sits" a flowchart;
//   a sequence diagram shows at least one refusal or failure path, not only the happy one;
//   a state diagram that names its source, "%% states: <file> <name>", has exactly the states the
//   code declares there. When the code gains or loses a state, the diagram fails.
// Rendering uses mmdc, the same tool live-labs uses: npm i -g @mermaid-js/mermaid-cli.
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { lessonFiles, sectionOf } from "./lesson-shape";
import { withoutFrontMatter } from "./plain-english";

export const WALKTHROUGH = "docs/walkthrough.md";

export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

const kindOf = (block: string) =>
  block.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("%%"))?.split(/\s/)[0] ?? "";

// A failure path: an alt/else/break block, or a message that refuses, holds or fails.
const FAILURE = /\b(refus\w*|den(y|ied)|block\w*|reject\w*|fail\w*|held|hold|stop\w*|withh\w*|403|401|timeout|expired|not allowed|cannot)\b/i;
export function hasFailurePath(block: string): boolean {
  return /^\s*(alt|else|break)\b/m.test(block) || block.split("\n").some((line) => /->>|-->>|-x|--x/.test(line) && FAILURE.test(line));
}

// The string values a type or const declares: `export type X = "a" | "b"`, an object type with a
// union field, or `export const X = ["a", "b"] as const`. Read up to the end of the declaration.
export function declaredStates(source: string, name: string): string[] {
  const start = source.search(new RegExp(`export\\s+(type|const)\\s+${name}\\b`));
  if (start < 0) return [];
  const rest = source.slice(start);
  const end = rest.search(/;\s*\n|\n\}\s*;?\s*\n|\]\s*as const/);
  const body = rest.slice(0, end < 0 ? undefined : end + 2);
  return [...new Set([...body.matchAll(/"([a-z_][a-z0-9_-]*)"/gi)].map((match) => match[1]))];
}

// States in a stateDiagram: every name on either side of an arrow and every `state X`.
export function diagramStates(block: string): string[] {
  const found = new Set<string>();
  for (const raw of block.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%") || line.startsWith("stateDiagram")) continue;
    const arrow = line.match(/^([\w-]+|\[\*\])\s*-->\s*([\w-]+|\[\*\])/);
    if (arrow) for (const side of [arrow[1], arrow[2]]) if (side !== "[*]") found.add(side);
    const declared = line.match(/^state\s+([\w-]+)/);
    if (declared) found.add(declared[1]);
  }
  return [...found];
}

export function statesProblems(file: string, block: string, read: (path: string) => string | null): string[] {
  const source = block.match(/^\s*%%\s*states:\s*(\S+)\s+(\w+)/m);
  if (!source) return [];
  const [, path, name] = source;
  const code = read(path);
  if (code === null) return [`${file}: state diagram names ${path}, which does not exist`];
  const declared = declaredStates(code, name);
  if (!declared.length) return [`${file}: state diagram names ${name} in ${path}, which declares no states`];
  const drawn = diagramStates(block);
  const problems: string[] = [];
  for (const state of declared) if (!drawn.includes(state)) problems.push(`${file}: state diagram misses "${state}" from ${path} ${name}`);
  for (const state of drawn) if (!declared.includes(state)) problems.push(`${file}: state diagram draws "${state}", which ${path} ${name} does not declare`);
  return problems;
}

export function diagramProblems(file: string, page: string, read: (path: string) => string | null, isLesson: boolean): string[] {
  const markdown = withoutFrontMatter(page);
  const problems: string[] = [];
  const blocks = mermaidBlocks(markdown);
  for (const block of blocks) {
    if (kindOf(block) === "sequenceDiagram" && !hasFailurePath(block)) {
      problems.push(`${file}: a sequence diagram shows only the happy path; draw a refusal or failure too`);
    }
    if (kindOf(block).startsWith("stateDiagram")) problems.push(...statesProblems(file, block, read));
  }
  if (isLesson) {
    if (!mermaidBlocks(sectionOf(markdown, "### The flow")).some((block) => kindOf(block) === "sequenceDiagram")) {
      problems.push(`${file}: "The flow" needs a sequence diagram of one real request`);
    }
    if (!mermaidBlocks(sectionOf(markdown, "### Where it sits")).some((block) => /^(flowchart|graph)$/.test(kindOf(block)))) {
      problems.push(`${file}: "Where it sits" needs a flowchart of the system`);
    }
    const states = sectionOf(markdown, "### The states");
    if (states && !mermaidBlocks(states).some((block) => /%%\s*states:/.test(block))) {
      problems.push(`${file}: "The states" needs a state diagram with a "%% states: <file> <name>" source`);
    }
  }
  return problems;
}

// GitHub's runners need Chromium without its sandbox, so mmdc reads this config.
const PUPPETEER = join(import.meta.dirname, "mermaid-puppeteer.json");

export function renderProblems(file: string, markdown: string): string[] {
  const blocks = mermaidBlocks(markdown);
  const dir = mkdtempSync(join(tmpdir(), "mmd-"));
  return blocks.flatMap((source, index) => {
    const input = join(dir, `block-${index + 1}.mmd`);
    writeFileSync(input, source);
    try {
      execFileSync("mmdc", ["-q", "-p", PUPPETEER, "-i", input, "-o", join(dir, `block-${index + 1}.svg`)], { stdio: "pipe" });
      return [];
    } catch (error) {
      const detail = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message).split("\n").find((line) => line.trim()) ?? "render failed";
      return [`${file}: diagram ${index + 1} does not render: ${detail.trim()}`];
    }
  });
}

const readIfThere = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : null);

if (import.meta.main) {
  try {
    execFileSync("mmdc", ["--version"], { stdio: "pipe" });
  } catch {
    console.error("mmdc is not installed. Run: npm i -g @mermaid-js/mermaid-cli");
    process.exit(1);
  }
  const pages = [...lessonFiles().map((file) => ({ file, isLesson: true })), { file: WALKTHROUGH, isLesson: false }];
  const problems = pages.flatMap(({ file, isLesson }) => {
    const page = readFileSync(file, "utf8");
    return [...diagramProblems(file, page, readIfThere, isLesson), ...renderProblems(file, page)];
  });
  for (const problem of problems) console.error(problem);
  if (problems.length) {
    console.error(`${problems.length} diagram problems.`);
    process.exit(1);
  }
  console.log(`Every diagram renders and matches the code: ${pages.length} pages.`);
}

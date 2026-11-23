// Fails when the repo ships a file or an npm script that nothing uses, or when code names a
// repo path that does not exist.
//
// Used means reachable. Every tracked text file outside the watched folders is a root. A watched
// file becomes used when a used file of the right kind names it as a whole path token:
//   data/          read by code (.ts, .tsx, package.json)
//   docs/images/   and public/: shown by a doc or the client (.md, .html, .css, .tsx)
//   scripts/       called by code, package.json, a workflow or a shell script
//   case-studies/  linked from a doc
// Comments in code do not count. An npm script is used when a doc shows `npm run <name>` as code,
// or another npm script calls it.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { fileURLToPath } from "node:url";

const CODE = /\.(ts|tsx|mjs|js|sh|ya?ml)$|^package\.json$/;
const RULES: Array<{ folder: string; usedBy: RegExp }> = [
  { folder: "data/", usedBy: /\.(ts|tsx)$|^package\.json$/ },
  { folder: "docs/images/", usedBy: /\.(md|html|css|tsx)$/ },
  { folder: "public/", usedBy: /\.(md|html|css|tsx|ts)$/ },
  { folder: "scripts/", usedBy: /\.(ts|sh|ya?ml)$|^package\.json$/ },
  { folder: "case-studies/", usedBy: /\.md$/ },
];
// Scripts people run by habit, never named in a lesson.
const ENTRY_SCRIPTS = new Set(["dev", "build", "start", "typecheck", "check"]);
const TEXT = /\.(ts|tsx|mjs|js|md|json|ya?ml|sh|html|css)$/;

function stripComments(path: string, body: string): string {
  if (/\.(ts|tsx|mjs|js)$/.test(path)) return body.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1");
  if (/\.(sh|ya?ml)$/.test(path)) return body.replace(/(^|\s)#.*$/gm, "$1");
  return body;
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function names(body: string, token: string): boolean {
  return new RegExp(`(^|[^\\w.-])${escape(token)}(?![\\w-]|\\.\\w)`, "m").test(body);
}

// The code a markdown file shows: fenced blocks and inline code spans.
function codeIn(markdown: string): string {
  const fenced = [...markdown.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map((match) => match[1]);
  const inline = [...markdown.replace(/```[\s\S]*?```/g, "").matchAll(/`([^`\n]+)`/g)].map((match) => match[1]);
  return [...fenced, ...inline].join("\n");
}

export function findProblems(files: Map<string, string>, tracked: string[]): string[] {
  const problems: string[] = [];
  const bodies = new Map([...files].map(([path, body]) => [path, stripComments(path, body)]));
  const ruleFor = (path: string) => RULES.find((rule) => path.startsWith(rule.folder));

  const used = new Set(tracked.filter((path) => !ruleFor(path)));
  const tokensFor = (path: string) => {
    const tokens = [path, basename(path)];
    if (path.endsWith(".ts")) tokens.push(`./${basename(path, ".ts")}`);
    return tokens;
  };
  for (let grew = true; grew; ) {
    grew = false;
    for (const path of tracked) {
      const rule = ruleFor(path);
      if (!rule || used.has(path)) continue;
      const reached = [...used].some(
        (user) => user !== path && rule.usedBy.test(basename(user)) && tokensFor(path).some((token) => names(bodies.get(user) ?? "", token)),
      );
      if (reached) {
        used.add(path);
        grew = true;
      }
    }
  }
  for (const path of tracked) {
    const rule = ruleFor(path);
    if (rule && !used.has(path)) problems.push(`${path}: nothing in use reads, links or calls it. Use it or delete it.`);
  }

  const known = new Set(tracked.flatMap((path) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  for (const [path, body] of bodies) {
    if (!CODE.test(basename(path))) continue;
    for (const match of body.matchAll(/["'`]((?:\.\.?\/)*(?:scripts|data|docs|public|src|langfuse)\/[\w./-]+)["'`]/g)) {
      const raw = match[1];
      const target = raw.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), raw)) : raw;
      const clean = target.replace(/\/$/, "");
      const exists = ["", ".ts", ".tsx", ".json", "/index.ts"].some((ending) => known.has(clean + ending));
      if (!exists) problems.push(`${path}: names ${raw}, which does not exist.`);
    }
  }

  const scripts: Record<string, string> = JSON.parse(files.get("package.json") ?? "{}").scripts ?? {};
  const shown = [...files].filter(([path]) => path.endsWith(".md")).map(([, body]) => codeIn(body)).join("\n");
  const calls = Object.values(scripts).join("\n");
  for (const name of Object.keys(scripts)) {
    if (ENTRY_SCRIPTS.has(name)) continue;
    const token = escape(name);
    const named = new RegExp(`npm run ${token}(?![\\w:-])`).test(shown);
    const called = new RegExp(`npm(:| run )${token}(?![\\w:-])`).test(calls);
    if (!named && !called) problems.push(`package.json script "${name}": no doc shows it and no script calls it.`);
  }
  return problems;
}

function main() {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const files = new Map(
    tracked.filter((path) => TEXT.test(path) && path !== "package-lock.json").map((path) => [path, readFileSync(path, "utf8")]),
  );
  const problems = findProblems(files, tracked);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("check-unused: every watched file and npm script is in use, and every named path exists");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

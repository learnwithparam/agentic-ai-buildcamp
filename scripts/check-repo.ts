// Fails when the repo ships a file or an npm script that nothing uses, when code names a
// repo path that does not exist, or when a dependency has no exact version.
//
// Used means reachable. Every tracked text file outside the watched folders is a root. A watched
// file becomes used when a used file of the right kind names it as a whole path token:
//   data/          read by code (.ts, .tsx, package.json)
//   docs/images/   and public/: shown by a doc or the client (.md, .html, .css, .tsx)
//   scripts/       called by code, package.json, a workflow or a shell script
//   case-studies/  linked from a doc
// Comments in code do not count. An npm script is used when a doc shows `npm run <name>` as code,
// or another npm script calls it. Every dependency is pinned to an exact version, so every
// checkout installs the same packages.
//
// The chat app: no name from the upstream app it was cut from survives in src/, colours are written
// only in tokens.css, and every CSS class is used by a component. The data/hcp copy matches its lock,
// and docs/coverage.md maps every case in it to a promise.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, posix } from "node:path";
import { fileURLToPath } from "node:url";
import { checkScoreboard } from "./scoreboard";
import { verifyDatasetCopy } from "./sync-dataset";

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
// Names from the upstream support app. The HCP agent replaced all of them.
const UPSTREAM_NAMES = ["PhonePanel", "deviceSummary", "notableApps", "search_help_library", "support-agent", "runSupportConversation", "Northvale", "CardioZ"];
const DATASET_COPY = "data/hcp/";
const TOKENS_FILE = "src/client/styles/tokens.css";
const COVERAGE_FILE = "docs/coverage.md";
const COLOUR = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i;
const withoutBlockComments = (body: string) => body.replace(/\/\*[\s\S]*?\*\//g, "");
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
    // data/hcp/ is a copy of the dataset repo; verifyDatasetCopy fails on any file not in its lock.
    if (path.startsWith(DATASET_COPY)) continue;
    if (rule && !used.has(path)) problems.push(`${path}: nothing in use reads, links or calls it. Use it or delete it.`);
  }

  const known = new Set(tracked.flatMap((path) => path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"))));
  for (const [path, body] of bodies) {
    // Test fixtures name made-up paths on purpose.
    if (!CODE.test(basename(path)) || path.endsWith(".test.ts")) continue;
    for (const match of body.matchAll(/["'`]((?:\.\.?\/)*(?:scripts|data|docs|public|src|langfuse)\/[\w./-]+)["'`]/g)) {
      const raw = match[1];
      const target = raw.startsWith(".") ? posix.normalize(posix.join(posix.dirname(path), raw)) : raw;
      const clean = target.replace(/\/$/, "");
      const exists = ["", ".ts", ".tsx", ".json", "/index.ts"].some((ending) => known.has(clean + ending));
      if (!exists) problems.push(`${path}: names ${raw}, which does not exist.`);
    }
  }

  const manifest = JSON.parse(files.get("package.json") ?? "{}");
  for (const field of ["dependencies", "devDependencies"]) {
    for (const [name, version] of Object.entries<string>(manifest[field] ?? {})) {
      if (!/^\d+\.\d+\.\d+$/.test(version)) problems.push(`package.json ${field} "${name}" is "${version}". Pin an exact version.`);
    }
  }
  // The Node version lives in package.json engines. CI reads it from there, and these docs
  // must quote it as it is.
  const node = manifest.engines?.node;
  for (const doc of ["README.md", "docs/learner/00-setup.md"]) {
    const body = files.get(doc);
    if (body !== undefined && !body.includes(`Node${doc === "README.md" ? "" : ".js"} \`${node}\``)) {
      problems.push(`${doc}: does not name the Node version from package.json engines (${node}).`);
    }
  }
  const scripts: Record<string, string> = manifest.scripts ?? {};
  const shown = [...files].filter(([path]) => path.endsWith(".md")).map(([, body]) => codeIn(body)).join("\n");
  const calls = Object.values(scripts).join("\n");
  for (const name of Object.keys(scripts)) {
    if (ENTRY_SCRIPTS.has(name)) continue;
    const token = escape(name);
    const named = new RegExp(`npm run ${token}(?![\\w:-])`).test(shown);
    const called = new RegExp(`npm(:| run )${token}(?![\\w:-])`).test(calls);
    if (!named && !called) problems.push(`package.json script "${name}": no doc shows it and no script calls it.`);
  }

  for (const [path, body] of bodies) {
    if (!path.startsWith("src/")) continue;
    for (const name of UPSTREAM_NAMES) {
      if (body.includes(name)) problems.push(path + ": still names " + name + " from the upstream app.");
    }
    if (path.startsWith("src/client/") && path !== TOKENS_FILE && /\.(css|tsx|ts|html)$/.test(path)) {
      const colour = COLOUR.exec(withoutBlockComments(body));
      if (colour) problems.push(path + ": writes the colour " + colour[0] + ". Colours live only in " + TOKENS_FILE + ".");
    }
  }
  const components = [...bodies]
    .filter(([path]) => path.startsWith("src/client/") && path.endsWith(".tsx"))
    .map(([, body]) => body)
    .join("\n");
  for (const [path, body] of files) {
    if (!path.startsWith("src/client/") || !path.endsWith(".css")) continue;
    // Keep only selectors: drop comments, font urls and declaration blocks.
    const selectors = withoutBlockComments(body).replace(/url\([^)]*\)/g, "").replace(/\{[^}]*\}/g, "{}");
    for (const className of new Set([...selectors.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((match) => match[1]))) {
      if (!names(components, className)) problems.push(path + ": class ." + className + " is not used by any component.");
    }
  }
  problems.push(...coverageProblems(files));
  return problems;
}

// docs/coverage.md maps every case in data/hcp/evals to a promise. A row with no case, an
// unknown case id, or a case in no row fails.
function coverageProblems(files: Map<string, string>): string[] {
  const coverage = files.get(COVERAGE_FILE);
  if (coverage === undefined) return [];
  const caseIds = new Set(
    [...files]
      .filter(([path]) => path.startsWith(DATASET_COPY + "evals/") && path.endsWith(".yaml"))
      .flatMap(([, body]) => [...body.matchAll(/^ {2}- description: "\[([A-Z0-9-]+)\]/gm)].map((match) => match[1])),
  );
  const problems: string[] = [];
  const covered = new Set<string>();
  const rows = coverage.split("\n").filter((line) => /^\|/.test(line) && !/^\|\s*(Promise|-)/.test(line));
  for (const row of rows) {
    const [promise, , cases = ""] = row.split("|").slice(1).map((cell) => cell.trim());
    const ids = cases.split(",").map((id) => id.trim()).filter(Boolean);
    if (ids.length === 0) problems.push(COVERAGE_FILE + ': "' + promise + '" has no case.');
    for (const id of ids) {
      if (!caseIds.has(id)) problems.push(COVERAGE_FILE + ": " + id + " is not a case in " + DATASET_COPY + "evals.");
      covered.add(id);
    }
  }
  for (const id of caseIds) {
    if (!covered.has(id)) problems.push(COVERAGE_FILE + ": case " + id + " is in no row.");
  }
  return problems;
}

function main() {
  const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
  const files = new Map(
    tracked.filter((path) => TEXT.test(path) && path !== "package-lock.json").map((path) => [path, readFileSync(path, "utf8")]),
  );
  const problems = [...findProblems(files, tracked), ...verifyDatasetCopy(), ...checkScoreboard()];
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    process.exit(1);
  }
  console.log("check-repo: every watched file and npm script is in use, every named path exists, every dependency is pinned, the chat app is clean, data/hcp matches its lock, docs/scoreboard.md has one cell per slice");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();

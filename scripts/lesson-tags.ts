// What each checkpoint tag holds, worked out from scripts/lesson-files.json.
//
// Tag N is the start of lesson N: it holds the files the lessons before N added, each at the
// version those lessons left. The manifest says, for every tracked file on main, the lesson that
// adds it. A file that later lessons change lists them too, so a tag gets the version the lessons
// before it left, not the finished one. Lesson 0 is the starting repo: its files are on every tag.
//
// Nothing here reads git or the network. The sync script (scripts/sync-checkpoints.sh) calls the
// "plan" command below; the tests in scripts/sync-checkpoints.test.ts call the functions.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Entry = number | number[] | "main";
export type Manifest = { lessonEnd: Record<string, string>; files: Record<string, Entry> };

export const LESSONS = Array.from({ length: 24 }, (_, lesson) => lesson);
const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MANIFEST_FILE = path.join(HERE, "lesson-files.json");

export function loadManifest(file = MANIFEST_FILE): Manifest {
  return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}

// The lessons that add or change a file, the lesson that adds it first. "main" has none.
export function versionsOf(entry: Entry): number[] {
  if (entry === "main") return [];
  return Array.isArray(entry) ? entry : [entry];
}

// A file added by lesson 0 is on every tag. A file added by lesson N is on every tag after N.
export function holds(entry: Entry, tag: number): boolean {
  const [added] = versionsOf(entry);
  return added !== undefined && (added === 0 || added < tag);
}

// The lesson whose version of the file tag N holds, or null when the tag does not hold the file.
export function versionOn(entry: Entry, tag: number): number | null {
  if (!holds(entry, tag)) return null;
  const seen = versionsOf(entry).filter((lesson) => lesson === 0 || lesson < tag);
  return Math.max(...seen);
}

export function tagFiles(manifest: Manifest, tag: number): string[] {
  return Object.keys(manifest.files)
    .filter((file) => holds(manifest.files[file], tag))
    .sort();
}

export type Source = { kind: "main" } | { kind: "commit"; ref: string } | { kind: "tag" };

// Where tag N's copy of a file comes from. The newest version is main's file. An older version is
// the file as main stood when the lesson before the next change ended. Before lesson 8 no commit
// holds a version of its own (the untraced app was cut by hand), so the tag keeps the copy it has.
export function sourceOf(manifest: Manifest, file: string, tag: number): Source {
  const entry = manifest.files[file];
  const version = versionOn(entry, tag);
  if (version === null) throw new Error(`${file} is not on tag ${tag}`);
  const versions = versionsOf(entry);
  const next = versions[versions.indexOf(version) + 1];
  if (next === undefined) return { kind: "main" };
  const ref = manifest.lessonEnd[String(next - 1)];
  return ref ? { kind: "commit", ref } : { kind: "tag" };
}

// ---- package.json: only the scripts whose files exist on the tag ------------------------------

const FILE = /(?:^|[\s"'])((?:scripts|src|infra|langfuse|data|docs)\/[\w./-]*\w|\.githooks)(?=$|[\s"'])/g;
const NPM_RUN = /npm(?: run |:)([\w:-]+)/g;

export function referencedFiles(command: string): string[] {
  return [...command.matchAll(FILE)].map((match) => match[1]);
}

// One `&&` step is kept when every file it names is on the tag and every npm script it calls is kept.
export function tagScripts(scripts: Record<string, string>, present: Set<string>): Record<string, string> {
  const filesPresent = (step: string) => referencedFiles(step).every((file) => [...present].some((have) => have === file || have.startsWith(`${file}/`)));
  let kept = { ...scripts };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, command] of Object.entries(kept)) {
      const steps = command.split(" && ").filter((step) => filesPresent(step) && [...step.matchAll(NPM_RUN)].every((call) => call[1] in kept));
      const next = steps.join(" && ");
      if (next === command) continue;
      changed = true;
      if (steps.length === 0) delete kept[name];
      else kept[name] = next;
    }
  }
  // Keep the order package.json has on main.
  return Object.fromEntries(Object.keys(scripts).filter((name) => name in kept).map((name) => [name, kept[name]]));
}

export function tagPackage(packageJson: string, present: Set<string>): string {
  const pkg = JSON.parse(packageJson) as { scripts?: Record<string, string>; bin?: Record<string, string> };
  pkg.scripts = tagScripts(pkg.scripts ?? {}, present);
  // `bin` names what `build:cli` writes, so it goes when the script does.
  if (!("build:cli" in pkg.scripts)) delete pkg.bin;
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

// ---- the dataset copy and its coverage table: only what the tag holds ------------------------

export function tagLock(lockJson: string, present: Set<string>): string {
  const lock = JSON.parse(lockJson) as { files: Record<string, string> };
  lock.files = Object.fromEntries(Object.entries(lock.files).filter(([rel]) => present.has(`data/hcp/${rel}`)));
  return `${JSON.stringify(lock, null, 2)}\n`;
}

// A row keeps the cases the tag holds; a row left with none goes.
export function tagCoverage(coverage: string, caseIds: Set<string>): string {
  return coverage
    .split("\n")
    .flatMap((line) => {
      if (!line.startsWith("|") || /^\|\s*(Promise|-)/.test(line)) return [line];
      const cells = line.split("|").slice(1, -1);
      const ids = (cells[2] ?? "").split(",").map((id) => id.trim()).filter((id) => caseIds.has(id));
      if (ids.length === 0) return [];
      cells[2] = ` ${ids.join(", ")} `;
      return [`|${cells.join("|")}|`];
    })
    .join("\n");
}

export function caseIdsIn(yaml: string): string[] {
  return [...yaml.matchAll(/^ {2}- description: "\[([A-Z0-9-]+)\]/gm)].map((match) => match[1]);
}

// ---- a lesson page's "You add" list ------------------------------------------------------------

// The paths a page names under "## Build it", in the list after its "You add" line. A path that
// ends in a slash is a folder. Short names such as `Editor.tsx` have no slash and are skipped.
export function youAdd(page: string): string[] {
  const build = page.split(/^## Build it$/m)[1]?.split(/^## /m)[0] ?? "";
  const lines = build.split("\n");
  const start = lines.findIndex((line) => /^You (add|change)\b/.test(line));
  if (start < 0) return [];
  const paths: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*$/.test(line) && paths.length > 0) break;
    if (!line.startsWith("- ")) continue;
    for (const token of line.replace(/:.*$/s, "").matchAll(/`([\w./-]+)`/g)) {
      if (token[1].includes("/")) paths.push(token[1]);
    }
  }
  return paths;
}

// The files on main a path names: the file itself, or, for a folder, the files under it that this
// lesson adds or changes (a later lesson may add more to the same folder).
export function expand(manifest: Manifest, name: string, lesson: number): string[] {
  if (name in manifest.files) return [name];
  const folder = name.endsWith("/") ? name : `${name}/`;
  return Object.keys(manifest.files).filter((file) => file.startsWith(folder) && versionsOf(manifest.files[file]).includes(lesson));
}

// ---- the command the sync script calls -----------------------------------------------------------

// plan <tag> [manifest]: one line per file the tag holds, "path<TAB>main|tag|commit <ref>".
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "plan") {
  const tag = Number(process.argv[3]);
  const manifest = loadManifest(process.argv[4] ?? MANIFEST_FILE);
  for (const file of tagFiles(manifest, tag)) {
    const source = sourceOf(manifest, file, tag);
    console.log(`${file}\t${source.kind === "commit" ? `commit ${source.ref}` : source.kind}`);
  }
}

// derive <dir>: rewrite package.json, the dataset lock and the coverage table inside a tag's tree
// so they list only what the tree holds.
function filesUnder(dir: string, prefix = ""): string[] {
  return readdirSync(path.join(dir, prefix)).flatMap((name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    return statSync(path.join(dir, rel)).isDirectory() ? filesUnder(dir, rel) : [rel];
  });
}

export function derive(dir: string) {
  const present = new Set(filesUnder(dir));
  const edit = (file: string, change: (text: string) => string) => {
    if (existsSync(path.join(dir, file))) writeFileSync(path.join(dir, file), change(readFileSync(path.join(dir, file), "utf8")));
  };
  edit("package.json", (text) => tagPackage(text, present));
  edit("data/hcp/dataset.lock.json", (text) => tagLock(text, present));
  const caseIds = new Set(
    [...present].filter((file) => /^data\/hcp\/evals\/[\w-]+\.yaml$/.test(file)).flatMap((file) => caseIdsIn(readFileSync(path.join(dir, file), "utf8"))),
  );
  edit("docs/coverage.md", (text) => tagCoverage(text, caseIds));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && process.argv[2] === "derive") {
  derive(process.argv[3]);
}

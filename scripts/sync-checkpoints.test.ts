import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { parse } from "yaml";
import {
  caseIdsIn,
  expand,
  holds,
  LESSONS,
  loadManifest,
  referencedFiles,
  sourceOf,
  tagCoverage,
  tagFiles,
  tagLock,
  tagPackage,
  tagScripts,
  versionOn,
  versionsOf,
  youAdd
} from "./lesson-tags";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const SCRIPT = path.join(ROOT, "scripts/sync-checkpoints.sh");
// The sync script lives on main only, so on a checkpoint tag there is nothing to check.
const onMain = existsSync(SCRIPT);
const manifest = loadManifest();
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const trackedFiles = () => execFileSync("git", ["ls-files"], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
const pageOf = (lesson: number) => {
  const name = readdirSync(path.join(ROOT, "docs/learner")).find((file) => file.startsWith(`${String(lesson).padStart(2, "0")}-`) && file.endsWith(".md"));
  assert.ok(name, `no page for lesson ${lesson}`);
  return `docs/learner/${name}`;
};

test("the checkpoint sync defaults to the fetched origin/main and verifies every tag", { skip: !onMain }, () => {
  const script = read("scripts/sync-checkpoints.sh");
  // A local main can be far behind; syncing from it rebuilt tag 00 from an old tree once.
  assert.doesNotMatch(script, /SOURCE_REF="\$\{SOURCE_REF:-main\}"/);
  assert.match(script, /git fetch -q origin main\n\s*SOURCE_REF=origin\/main/);
  // --verify runs the check before the "already in sync" skip, so an unmoved tag is checked too.
  const verify = script.indexOf('if [[ "$VERIFY" -eq 1 ]]; then\n    echo "    npm run check"');
  const skip = script.indexOf('echo "    already in sync with $SOURCE_REF"');
  assert.ok(verify > 0 && skip > verify, "--verify must run npm run check before a tag in sync is skipped");
});

test("every tracked file on main has an owner lesson, and the manifest names no file that is gone", { skip: !onMain }, () => {
  const tracked = new Set(trackedFiles());
  const unowned = [...tracked].filter((file) => !(file in manifest.files));
  assert.deepEqual(unowned, [], `no lesson owns: ${unowned.join(", ")}. Add them to scripts/lesson-files.json.`);
  const gone = Object.keys(manifest.files).filter((file) => !tracked.has(file));
  assert.deepEqual(gone, [], `the manifest names files that are not tracked: ${gone.join(", ")}`);
});

test("a file's lessons rise, and each is a lesson that exists", () => {
  for (const [file, entry] of Object.entries(manifest.files)) {
    if (entry === "main") continue;
    const lessons = Array.isArray(entry) ? entry : [entry];
    assert.ok(lessons.every((lesson) => LESSONS.includes(lesson)), `${file}: a lesson outside 0 to 23`);
    assert.deepEqual(lessons, [...new Set(lessons)].sort((a, b) => a - b), `${file}: lessons must rise, each once`);
  }
});

// The files a script names, read a second way: every word that looks like a path, whatever the
// filter in tagScripts thinks. A glob or a build folder is not a file the tag must hold.
function pathsNamed(command: string): string[] {
  return command
    .split(/[\s"']+/)
    .filter((word) => word && !word.startsWith("-") && !word.includes("*") && !word.startsWith("dist/") && !word.startsWith("npm:"))
    .filter((word) => /\.(ts|tsx|sh|mjs|ya?ml|json)$/.test(word) || word === ".githooks");
}

test("on every tag, each npm script names only files the tag holds", { skip: !onMain }, () => {
  const packageJson = read("package.json");
  for (const lesson of LESSONS) {
    const present = new Set(tagFiles(manifest, lesson));
    const scripts = (JSON.parse(tagPackage(packageJson, present)) as { scripts: Record<string, string> }).scripts;
    for (const [name, command] of Object.entries(scripts)) {
      for (const file of pathsNamed(command)) {
        const held = [...present].some((have) => have === file || have.startsWith(`${file}/`));
        assert.ok(held, `tag ${lesson}: the script "${name}" runs ${file}, which the tag does not hold`);
      }
      for (const called of command.matchAll(/npm(?: run |:)([\w:-]+)/g)) {
        assert.ok(called[1] in scripts, `tag ${lesson}: the script "${name}" calls "${called[1]}", which the tag does not have`);
      }
    }
  }
});

// The text of a file as tag N holds it: main's copy, or the older commit the manifest names. A
// hand-cut version (lessons 0 to 2) has no commit, so it is not read here.
const textCache = new Map<string, string | undefined>();
function textOn(file: string, tag: number): string | undefined {
  const source = sourceOf(manifest, file, tag);
  if (source.kind === "tag") return undefined;
  if (source.kind === "main") return read(file);
  const key = `${source.ref}:${file}`;
  if (!textCache.has(key)) {
    try {
      textCache.set(key, execFileSync("git", ["show", key], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26 }));
    } catch {
      textCache.set(key, undefined);
    }
  }
  return textCache.get(key);
}

// A file on a tag needs every file it imports on that tag too. A tag's copy of a file is an older
// version when a later lesson changes it, so what it imports is read from that version.
test("on every tag, a file imports only files the tag holds", { skip: !onMain }, () => {
  const problems: string[] = [];
  for (const lesson of LESSONS) {
    const held = new Set(tagFiles(manifest, lesson));
    for (const file of held) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      const body = textOn(file, lesson);
      if (body === undefined) continue;
      for (const match of body.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
        const target = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`].find((name) => name in manifest.files);
        if (target && !held.has(target)) problems.push(`tag ${lesson}: ${file} imports ${target}, which the tag lacks`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("the script filter keeps a script whose files are there and drops the rest", () => {
  const scripts = { a: "tsx scripts/a.ts", b: "tsx scripts/b.ts", both: "npm run a && npm run b", gone: "npm run b" };
  assert.deepEqual(tagScripts(scripts, new Set(["scripts/a.ts"])), { a: "tsx scripts/a.ts", both: "npm run a" });
  assert.deepEqual(referencedFiles("tsx watch src/server/index.ts"), ["src/server/index.ts"]);
});

test("a lesson page lists the files it adds, and the tag before it does not hold them", { skip: !onMain }, () => {
  const problems: string[] = [];
  for (const lesson of LESSONS.filter((n) => n >= 10)) {
    const page = pageOf(lesson);
    const named = youAdd(read(page));
    if (named.length === 0) problems.push(`${page}: no "You add" list under "Build it"`);
    for (const name of named) {
      const files = expand(manifest, name, lesson);
      if (files.length === 0) problems.push(`${page}: ${name} is no file this lesson adds or changes`);
      for (const file of files) {
        const entry = manifest.files[file];
        const own = `${page}: ${file}`;
        // Added by this lesson: not on its own tag. Changed by this lesson: its own tag holds an older version.
        if (!versionsOf(entry).includes(lesson)) problems.push(holds(entry, lesson) ? `${own} is already on tag ${lesson}` : `${own} is added by a later lesson`);
        else if (!holds(entry, lesson + 1)) problems.push(`${own} is missing from tag ${lesson + 1}, the next tag`);
        else if (versionOn(entry, lesson + 1) !== lesson) problems.push(`${own} is not at lesson ${lesson}'s version on tag ${lesson + 1}`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

// The lesson an eval case belongs to is its `chapter`, except in medinfo.yaml: that file is the
// dataset lesson's own, and its cases name the chapter that makes them pass (a case is red on
// purpose until then), so they are on the tag from lesson 5 on.
const chaptersIn = (file: string) => [...new Set((parse(read(file)) as { tests: Array<{ metadata: { chapter: string } }> }).tests.map((test) => Number(test.metadata.chapter)))];
const evalFiles = Object.keys(manifest.files).filter((file) => /^data\/hcp\/evals\/[\w-]+\.yaml$/.test(file));

test("a tag holds no eval case from a later lesson", { skip: !onMain }, () => {
  const problems: string[] = [];
  for (const lesson of LESSONS) {
    const held = tagFiles(manifest, lesson).filter((file) => evalFiles.includes(file));
    for (const file of held.filter((name) => !name.endsWith("/medinfo.yaml"))) {
      const late = chaptersIn(file).filter((chapter) => chapter >= lesson);
      if (late.length > 0) problems.push(`tag ${lesson} holds ${file}, whose cases are chapter ${late.join(", ")}`);
    }
    // The case ids the tag holds are the ids its coverage table keeps.
    const ids = new Set(held.flatMap((file) => caseIdsIn(read(file))));
    const rows = tagCoverage(read("docs/coverage.md"), ids)
      .split("\n")
      .filter((line) => line.startsWith("|") && !/^\|\s*(Promise|-)/.test(line));
    for (const row of rows) {
      for (const id of row.split("|")[3].split(",").map((cell) => cell.trim())) {
        if (!ids.has(id)) problems.push(`tag ${lesson}: the coverage table names ${id}, a case the tag lacks`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("each agent's eval file comes with the lesson its cases belong to", { skip: !onMain }, () => {
  for (const file of evalFiles.filter((name) => !name.endsWith("/medinfo.yaml"))) {
    const [added] = versionsOf(manifest.files[file]);
    assert.deepEqual(chaptersIn(file), [added], `${file}: its cases are chapter ${chaptersIn(file)}, but lesson ${added} adds the file`);
  }
});

test("a tag's dataset lock lists only the files the tag holds", { skip: !onMain }, () => {
  const present = new Set(tagFiles(manifest, 12));
  const lock = JSON.parse(tagLock(read("data/hcp/dataset.lock.json"), present)) as { files: Record<string, string> };
  assert.ok(Object.keys(lock.files).length > 0);
  for (const rel of Object.keys(lock.files)) assert.ok(present.has(`data/hcp/${rel}`), `${rel} is in the lock but not on tag 12`);
  assert.ok(!("evals/a2a.yaml" in lock.files), "lesson 15's cases are not on tag 12");
});

test("where a file's version comes from", () => {
  const entry = manifest.files["src/server/medinfo-agent.ts"];
  assert.deepEqual(sourceOf(manifest, "src/server/medinfo-agent.ts", 1), { kind: "tag" });
  assert.equal(sourceOf(manifest, "src/server/medinfo-agent.ts", 24).kind, "main");
  assert.equal(versionOn(entry, 0), 0);
  assert.equal(versionOn(manifest.files["src/server/gateway.ts"], 10), null);
});

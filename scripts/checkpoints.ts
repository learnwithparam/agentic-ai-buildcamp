// bun run checkpoints --dry     build every checkpoint in .checkpoints/ and type-check each one
// bun run checkpoints --tag     the same, then write one tag per unit (the release job does this)
// bun run checkpoints --prove   also run verify inside each checkpoint (the release job does this)
//                               the unit before it must pass and the unit itself must fail
//
// Main holds the finished course. A checkpoint is main with every region of the unit, and of every
// later unit, replaced by its stub. See scripts/regions.ts for the marker format.
import { cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tagFor, UNITS, type Unit, unitBySlug } from "../src/workshop";
import { git, mustGit } from "./git";
import { finishedBefore, regionsIn, render } from "./regions";
import { ROOT } from "./root";

const OUT = join(ROOT, ".checkpoints");
const CODE = /\.(ts|tsx|mjs|js)$/;

export function trackedFiles(): string[] {
  const listed = mustGit(["ls-files", "-co", "--exclude-standard"]);
  return listed.split("\n").filter((name) => name !== "" && !name.startsWith(".checkpoints/"));
}

export function folderFor(unit: Unit): string {
  return join(OUT, tagFor(unit.slug).replace("/", "-"));
}

// Write one checkpoint folder. Returns the regions it left as stubs, for the report.
export function build(unit: Unit, files: string[]): number {
  const finished = finishedBefore(unit.slug);
  const folder = folderFor(unit);
  rmSync(folder, { recursive: true, force: true });
  let stubbed = 0;
  for (const name of files) {
    const target = join(folder, name);
    mkdirSync(dirname(target), { recursive: true });
    if (!CODE.test(name)) {
      cpSync(join(ROOT, name), target);
      continue;
    }
    const source = readFileSync(join(ROOT, name), "utf8");
    stubbed += regionsIn(source, name).filter((region) => !finished.has(region.slug)).length;
    writeFileSync(target, render(source, finished, name));
  }
  return stubbed;
}

function typecheck(folder: string): boolean {
  const result = Bun.spawnSync(["bunx", "tsc", "-p", join(folder, "tsconfig.json")], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) console.log(result.stdout.toString() + result.stderr.toString());
  return result.exitCode === 0;
}

// Commit the folder as one commit on top of main, then point the tag at it.
function writeTag(unit: Unit): void {
  const folder = folderFor(unit);
  const gitDir = mustGit(["rev-parse", "--absolute-git-dir"]);
  const env = Object.fromEntries([
    ["GIT_DIR", gitDir],
    ["GIT_WORK_TREE", folder],
    ["GIT_INDEX_FILE", `${folder}.index`],
  ]);
  const head = mustGit(["rev-parse", "HEAD"]);
  mustGit(["read-tree", "--empty"], { env });
  mustGit(["add", "-A", "-f"], { cwd: folder, env });
  const tree = mustGit(["write-tree"], { env });
  const message = `Checkpoint ${tagFor(unit.slug)} from ${head.slice(0, 7)}`;
  const commit = mustGit(["commit-tree", tree, "-p", head, "-m", message], { env });
  mustGit(["tag", "-f", tagFor(unit.slug), commit]);
}

function passes(folder: string, slug: string): boolean {
  const run = Bun.spawnSync(["bun", "scripts/verify.ts", slug], {
    cwd: folder,
    stdout: "pipe",
    stderr: "pipe",
  });
  return run.exitCode === 0;
}

// Inside the checkpoint, the unit before must pass and the unit itself must still fail.
function proves(unit: Unit): boolean {
  if (!unit.built) return true;
  const folder = folderFor(unit);
  symlinkSync(join(ROOT, "node_modules"), join(folder, "node_modules"));
  Bun.spawnSync(["bun", "scripts/seed.ts"], { cwd: folder, stdout: "ignore", stderr: "ignore" });
  let good = true;
  if (passes(folder, unit.slug)) {
    console.log(`FAIL  ${tagFor(unit.slug)}: its own verify passes before the learner builds it`);
    good = false;
  }
  const before = unit.needs === null ? undefined : unitBySlug(unit.needs);
  if (before?.built && !passes(folder, before.slug)) {
    console.log(`FAIL  ${tagFor(unit.slug)}: the verify before it, ${before.slug}, does not pass`);
    good = false;
  }
  return good;
}

function checkOne(unit: Unit, files: string[], writing: boolean, proving: boolean): boolean {
  const stubbed = build(unit, files);
  let good = typecheck(folderFor(unit));
  if (good && proving) good = proves(unit);
  console.log(`${good ? "PASS" : "FAIL"}  ${tagFor(unit.slug)}  (${stubbed} stubs)`);
  if (good && writing) writeTag(unit);
  return good;
}

function refuse(message: string, code: number): never {
  console.log(message);
  process.exit(code);
}

function main(): void {
  const writing = process.argv.includes("--tag");
  const proving = process.argv.includes("--prove");
  if (!(writing || proving || process.argv.includes("--dry"))) {
    refuse("Say --dry to check every checkpoint, or --tag to write the tags.", 2);
  }
  if (writing && git(["status", "--porcelain"]).output !== "") {
    refuse("The tree is not clean. Commit first, so each tag names a real commit.", 1);
  }
  const files = trackedFiles();
  const results = UNITS.map((unit) => checkOne(unit, files, writing, proving));
  rmSync(OUT, { recursive: true, force: true });
  if (results.includes(false)) process.exit(1);
}

if (import.meta.main) main();

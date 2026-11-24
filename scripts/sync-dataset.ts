/**
 * Copies the HCP files from the dataset repo, at one pinned commit, into data/hcp/.
 * The copy is never edited by hand: check-repo runs `verifyDatasetCopy` and fails
 * when any byte differs from the lock.
 *
 *   npx tsx scripts/sync-dataset.ts                 # verify the copy against the lock
 *   npx tsx scripts/sync-dataset.ts --update <sha>  # copy that commit and rewrite the lock
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const COPY_DIR = path.join(ROOT, "data/hcp");
const LOCK_FILE = path.join(COPY_DIR, "dataset.lock.json");
const REPO = "learnwithparam/dataset";

// Upstream folder -> folder inside data/hcp.
const SOURCES: Array<[string, string]> = [
  ["data/hcp/", ""],
  ["evals/hcp/", "evals/"]
];

type Lock = { repo: string; commit: string; files: Record<string, string> };

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function listCopy(dir = COPY_DIR, prefix = ""): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    const rel = prefix + name;
    if (statSync(full).isDirectory()) return listCopy(full, `${rel}/`);
    return rel === "dataset.lock.json" ? [] : [rel];
  });
}

export function verifyDatasetCopy(): string[] {
  const lock = JSON.parse(readFileSync(LOCK_FILE, "utf8")) as Lock;
  const problems: string[] = [];
  const onDisk = new Set(listCopy());
  for (const [rel, hash] of Object.entries(lock.files)) {
    if (!onDisk.has(rel)) {
      problems.push(`data/hcp/${rel} is in the lock but missing on disk`);
      continue;
    }
    if (sha256(readFileSync(path.join(COPY_DIR, rel))) !== hash) {
      problems.push(`data/hcp/${rel} differs from ${lock.repo}@${lock.commit.slice(0, 7)}`);
    }
    onDisk.delete(rel);
  }
  for (const rel of onDisk) problems.push(`data/hcp/${rel} is not from the dataset repo`);
  return problems;
}

async function update(commit: string) {
  const tree = (await (
    await fetch(`https://api.github.com/repos/${REPO}/git/trees/${commit}?recursive=1`, {
      signal: AbortSignal.timeout(30_000)
    })
  ).json()) as { sha?: string; tree?: Array<{ path: string; type: string }> };
  if (!tree.tree) throw new Error(`Commit ${commit} not found in ${REPO}.`);

  rmSync(COPY_DIR, { recursive: true, force: true });
  const files: Record<string, string> = {};
  for (const entry of tree.tree) {
    if (entry.type !== "blob") continue;
    const source = SOURCES.find(([from]) => entry.path.startsWith(from));
    if (!source) continue;
    const rel = source[1] + entry.path.slice(source[0].length);
    const response = await fetch(`https://raw.githubusercontent.com/${REPO}/${commit}/${entry.path}`, {
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) throw new Error(`Could not fetch ${entry.path}: ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    mkdirSync(path.dirname(path.join(COPY_DIR, rel)), { recursive: true });
    writeFileSync(path.join(COPY_DIR, rel), bytes);
    files[rel] = sha256(bytes);
  }
  const lock: Lock = { repo: REPO, commit: tree.sha ?? commit, files };
  writeFileSync(LOCK_FILE, `${JSON.stringify(lock, null, 2)}\n`);
  console.log(`Copied ${Object.keys(files).length} files from ${REPO}@${lock.commit.slice(0, 7)}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf("--update");
  if (index !== -1) {
    const commit = process.argv[index + 1];
    if (!commit) throw new Error("Pass the dataset commit: --update <sha>");
    await update(commit);
  } else {
    const problems = verifyDatasetCopy();
    for (const problem of problems) console.error(problem);
    if (problems.length > 0) process.exit(1);
    console.log("data/hcp matches the dataset lock.");
  }
}

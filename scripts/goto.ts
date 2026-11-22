// bun run goto <slug>            move to a checkpoint, keeping your lab work
// bun run goto <slug> --fresh    take the reference lab files too
//
// A dirty tree is saved on a backup branch first, so nothing you wrote is lost.
import { tagFor, UNITS, unitBySlug } from "../src/workshop";
import { git, mustGit } from "./git";

const KEPT_FOLDERS = ["apps/product-teammates", "design-pack"];

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
}

function saveDirtyTree(): string | null {
  if (git(["status", "--porcelain"]).output === "") return null;
  const branch = `backup/${stamp()}`;
  mustGit(["checkout", "-b", branch]);
  mustGit(["add", "-A"]);
  mustGit(["commit", "-m", `Save work before goto at ${branch}`]);
  return branch;
}

function stubsLeft(): string[] {
  const found = git(["grep", "-n", "TODO(", "--", "*.ts"]);
  return found.ok ? found.output.split("\n") : [];
}

function main(): void {
  const slug = process.argv[2];
  const unit = slug ? unitBySlug(slug) : undefined;
  if (unit === undefined) {
    console.log("Say which module or lab. The names are:");
    for (const other of UNITS) console.log(`  bun run goto ${other.slug}`);
    process.exit(2);
  }
  const fresh = process.argv.includes("--fresh");
  const saved = saveDirtyTree();
  const mine = saved ?? "HEAD";
  const branch = `work/${unit.slug}`;
  mustGit(["checkout", "-B", branch, tagFor(unit.slug)]);
  if (!fresh && saved !== null) {
    for (const folder of KEPT_FOLDERS) git(["checkout", mine, "--", folder]);
  }
  if (saved !== null) console.log(`Your earlier work is saved on ${saved}.`);
  console.log(`You are on ${branch}. Open each TODO and write the answer:`);
  for (const line of stubsLeft().filter((text) => text.includes(`TODO(${unit.slug})`))) {
    console.log(`  ${line}`);
  }
}

main();

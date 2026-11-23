// bun run goto <slug>            move to a checkpoint, keeping your lab work
// bun run goto <slug> --fresh    take the reference lab files too
//
// It refuses a tree with changes, so nothing you wrote can be lost. Commit first, then go.
import { branchFor, UNITS, type Unit, unitBySlug } from "../src/workshop";
import { git, mustGit } from "./git";

const KEPT_FOLDERS = ["apps/product-teammates", "design-pack"];

function stubsLeft(): string[] {
  const found = git(["grep", "-n", "TODO(", "--", "*.ts"]);
  return found.ok ? found.output.split("\n") : [];
}

function chooseUnit(): Unit {
  const unit = unitBySlug(process.argv[2] ?? "");
  if (unit !== undefined) return unit;
  console.log("Say which module or lab. The names are:");
  for (const other of UNITS) console.log(`  bun run goto ${other.slug}`);
  process.exit(2);
}

function refuseDirtyTree(): void {
  if (git(["status", "--porcelain"]).output === "") return;
  console.log("You have changes that are not saved. Save them first, then run goto again:");
  console.log("  git add -A && git commit -m 'My work'");
  process.exit(1);
}

function main(): void {
  const unit = chooseUnit();
  refuseDirtyTree();
  const fetched = git(["fetch", "origin"]);
  if (!fetched.ok) {
    console.log(`Could not fetch the checkpoints from GitHub:\n${fetched.output}`);
    process.exit(1);
  }
  const mine = mustGit(["rev-parse", "HEAD"]);
  const work = `work/${unit.slug}`;
  mustGit(["switch", "-C", work, `origin/${branchFor(unit.slug)}`]);
  if (!process.argv.includes("--fresh")) {
    for (const folder of KEPT_FOLDERS) git(["checkout", mine, "--", folder]);
  }
  console.log(`You are on ${work}. Open each TODO and write the answer:`);
  for (const line of stubsLeft().filter((text) => text.includes(`TODO(${unit.slug})`))) {
    console.log(`  ${line}`);
  }
}

main();

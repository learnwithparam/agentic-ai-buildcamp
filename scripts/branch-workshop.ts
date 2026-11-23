// bun scripts/branch-workshop.ts <release-tag> --dry     show the branches it would make
// bun scripts/branch-workshop.ts <release-tag>           make them in this repo
//
// A workshop repo gets one branch per module and lab. Every branch starts from a release tag.
// A tag never moves, so every workshop starts from the same place. A checkpoint branch moves,
// so it is never a starting point. Run `bun run checkpoints --at <tag> --branches` to fill them.
import { branchNames, isUnitBranch } from "../src/branches";
import { git } from "./git";

export type Plan = { ok: true; make: string[]; skip: string[] } | { ok: false; reason: string };

export type Facts = { isTag: boolean; existing: string[] };

export function plan(start: string, facts: Facts): Plan {
  if (start === "") return { ok: false, reason: "Say which release tag to start from." };
  if (isUnitBranch(start)) {
    return { ok: false, reason: `${start} is a checkpoint branch. Start from a release tag.` };
  }
  if (!facts.isTag) return { ok: false, reason: `${start} is not a release tag.` };
  const names = branchNames();
  return {
    ok: true,
    make: names.filter((name) => !facts.existing.includes(name)),
    skip: names.filter((name) => facts.existing.includes(name)),
  };
}

function readFacts(start: string): Facts {
  const tag = git(["rev-parse", "--verify", "--quiet", `refs/tags/${start}^{commit}`]);
  const listed = git(["for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
  return { isTag: tag.ok, existing: listed.output.split("\n").filter((name) => name !== "") };
}

function main(): void {
  const start = process.argv[2] ?? "";
  const result = plan(start, readFacts(start));
  if (!result.ok) {
    console.log(result.reason);
    process.exit(2);
  }
  const dry = process.argv.includes("--dry");
  for (const name of result.skip) console.log(`SKIP  ${name} (already there)`);
  for (const name of result.make) {
    if (dry) {
      console.log(`WOULD MAKE  ${name} from ${start}`);
      continue;
    }
    const made = git(["branch", name, `refs/tags/${start}`]);
    console.log(`${made.ok ? "MADE" : "FAIL"}  ${name}`);
    if (!made.ok) process.exit(1);
  }
}

if (import.meta.main) main();

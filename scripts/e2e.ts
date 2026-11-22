// bun run e2e starts the stack and runs every unit verify on main, in order.
// Every unit must pass, because main holds the finished course. Run it before a release.
import { provider } from "../config/models";
import { UNITS } from "../src/workshop";
import { startStack } from "./up";

function run(command: string[]): boolean {
  return Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" }).exitCode === 0;
}

await startStack();
const failed: string[] = [];
for (const unit of UNITS.filter((item) => item.built)) {
  if (!run(["bun", "scripts/verify.ts", unit.slug])) failed.push(unit.slug);
}
// The full golden set needs recorded replies or a live model. Without either, only the units run.
if (provider() === "replay") {
  console.log("Skipped the full golden set: set LLM_PROVIDER and a key, then run again.");
} else if (!run(["bun", "scripts/eval.ts", "--live"])) {
  failed.push("full golden set");
}
if (failed.length > 0) {
  console.log(`These did not pass: ${failed.join(", ")}`);
  process.exit(1);
}
console.log("Every unit passed.");
process.exit(0);

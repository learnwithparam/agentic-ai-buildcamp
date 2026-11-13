// bun assignment/check.ts [folder]: check your graph and write result.json.
// With no folder it checks the graph files in assignment/. Exit 0 when every line passes.
import { evaluate, writeResult } from "../checks/lib/langgraph-assignment";

const found = await evaluate(process.argv[2] ?? import.meta.dir);
writeResult(found);
let failed = false;
for (const [language, lines] of Object.entries(found)) {
  for (const line of lines) {
    console.log(`  ${line.result.toUpperCase().padEnd(7)} [${language}] ${line.says}`);
    if (line.result !== "pass") failed = true;
  }
}
console.log(failed ? "Some lines did not pass. See result.json." : "Every line passes.");
process.exit(failed ? 1 : 0);

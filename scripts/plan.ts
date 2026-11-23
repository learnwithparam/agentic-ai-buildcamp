// Print every unit as green or red against the approved plan. Exit 1 while any unit is red.
// Green needs evidence from a real run on the gateway: bun run verify <slug>
import { redReason } from "../src/plan";
import { UNITS } from "../src/workshop";
import { ROOT } from "./root";

let red = 0;
for (const unit of UNITS) {
  const reason = redReason(ROOT, unit.slug);
  if (reason === null) {
    console.log(`green  ${unit.slug}`);
    continue;
  }
  red += 1;
  console.log(`red    ${unit.slug}: ${reason}`);
}
console.log(`${UNITS.length - red} green, ${red} red.`);
process.exit(red > 0 ? 1 : 0);

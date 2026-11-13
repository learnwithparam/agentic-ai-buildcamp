// Starts the Operate part's sample employee. The checker runs this from employee.toml.
//   bun start.ts                         ready for production (the sample solution)
//   bun start.ts <mistake>               one planted mistake, for a wrong/ folder
import { type Options, operateEmployee } from "./kit";

const MISTAKES: Record<string, Partial<Options>> = {
  "forgets-failed-runs": { countFailedRuns: false },
  "fails-when-the-ledger-is-down": { pauseOnOutage: false },
  "a-card-per-job": { oneIncidentCard: false },
};
const mistake = process.argv[2];
if (mistake && !MISTAKES[mistake]) {
  console.log(
    `There is no mistake called "${mistake}". Try one of: ${Object.keys(MISTAKES).join(", ")}`,
  );
  process.exit(2);
}
let options: Partial<Options> = {};
if (mistake) options = MISTAKES[mistake];
const employee = await operateEmployee(options);
const address = `http://localhost:${employee.port}`;
console.log(`freight-audit-clerk answers contract 1 on ${address} (model role: ${employee.role})`);

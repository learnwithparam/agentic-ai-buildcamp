// Starts the Deploy part's sample employee. The checker runs this from employee.toml
// through `bun run deploy-employee`, so it works from any folder inside the repo.
import { deployEmployee } from "./deploy-kit";

const employee = deployEmployee();
console.log(`freight-audit-clerk answers contract 1 on http://localhost:${employee.port}`);

// Starts the reference employee. The checker runs this from employee.toml; so does `bun run reference`.
import { startEmployee } from "./src/employee";
const e = startEmployee();
console.log(`freight-audit-clerk answers contract 1 on http://localhost:${e.port}`);

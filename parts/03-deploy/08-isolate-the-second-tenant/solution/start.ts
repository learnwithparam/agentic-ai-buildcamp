// The sample answer. Every behaviour lives in parts/03-deploy/deploy-kit.ts.
import { deployEmployee } from "../../deploy-kit";

const employee = deployEmployee();
console.log(`freight-audit-clerk answers contract 1 on http://localhost:${employee.port}`);

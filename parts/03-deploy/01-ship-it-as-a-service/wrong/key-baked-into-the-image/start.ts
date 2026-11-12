// The same employee as the sample answer. The mistake is in compose.yaml or the Dockerfile in this folder.
import { deployEmployee } from "../../../deploy-kit";
const e = deployEmployee();
console.log(`freight-audit-clerk answers contract 1 on http://localhost:${e.port}`);

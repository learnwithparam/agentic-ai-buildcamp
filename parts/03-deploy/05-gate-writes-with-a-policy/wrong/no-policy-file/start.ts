// A common mistake: the limits live in code and environment settings, and no policy.yaml ships with the employee,
// so nobody can read the rules or change a limit in one reviewed file.
import { deployEmployee } from "../../../deploy-kit";
deployEmployee({ policyFromFile: false });

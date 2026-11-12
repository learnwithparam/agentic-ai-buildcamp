// A common mistake: Keeps the USD 5,000 limit in code, so a change to policy.yaml changes nothing.
import { deployEmployee } from "../../../deploy-kit";
deployEmployee({ policyFromFile: false });

// A common mistake: Has no gate, so text in a scan that names an approver counts as an approval.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ policyGate: false });

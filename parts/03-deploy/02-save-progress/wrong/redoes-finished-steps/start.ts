// A common mistake: saves the job but not its steps.
// So a resume reads the evidence and asks the model again.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ saveSteps: false });

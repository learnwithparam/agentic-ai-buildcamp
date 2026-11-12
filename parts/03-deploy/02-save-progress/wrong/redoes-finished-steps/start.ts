// A common mistake: Saves the job but not its steps, so a resume reads the evidence and asks the model again.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ saveSteps: false });

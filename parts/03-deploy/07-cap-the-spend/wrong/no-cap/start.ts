// A common mistake: Reads the budget but never stops a job at it.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ budget: false });

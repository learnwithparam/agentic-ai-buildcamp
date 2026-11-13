// A common mistake: Records every job as started by a person, whatever started it.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ labelTrigger: false });

// A common mistake: Keeps jobs in memory, so a restart forgets them.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ persist: false });

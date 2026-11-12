// A common mistake: Puts every tenant's jobs in one kaas-freight row on the board.
import { deployEmployee } from "../../../deploy-kit";
deployEmployee({ boardByTenant: false });

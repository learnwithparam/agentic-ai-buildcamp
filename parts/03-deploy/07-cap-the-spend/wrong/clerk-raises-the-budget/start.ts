// A common mistake: Lets anyone who may approve payments raise a budget.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ onlyFinanceLeadRaises: false });

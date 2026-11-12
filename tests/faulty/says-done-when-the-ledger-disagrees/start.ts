// Planted fault: Trusts the pay call and never reads the ledger after it.
import { startEmployee } from "../../../reference/src/employee";
startEmployee({ settleCheck: false });

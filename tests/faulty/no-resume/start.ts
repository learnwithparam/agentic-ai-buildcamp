// Planted fault: Keeps jobs in memory, so a restart forgets them.
import { startEmployee } from "../../../reference/src/employee";
startEmployee({ persist: false });

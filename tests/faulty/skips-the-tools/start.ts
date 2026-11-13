// Planted fault: Says done without reading anything or writing anything.
import { startEmployee } from "../../../reference/src/employee";

startEmployee({ readTools: false });

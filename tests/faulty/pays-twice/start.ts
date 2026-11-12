// Planted fault: Uses a new Idempotency-Key on every try and after every restart.
import { startEmployee } from "../../../reference/src/employee";

startEmployee({ stableKeys: false });

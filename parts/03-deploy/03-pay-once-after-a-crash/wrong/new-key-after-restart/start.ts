// A common mistake: makes a new Idempotency-Key on every try.
// So the retry after a restart pays the invoice again.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ stableKeys: false });

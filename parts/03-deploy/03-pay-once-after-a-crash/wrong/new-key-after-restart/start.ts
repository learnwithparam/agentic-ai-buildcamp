// A common mistake: Makes a new Idempotency-Key on every try, so the retry after a restart pays again.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ stableKeys: false });

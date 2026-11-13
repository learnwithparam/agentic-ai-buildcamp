// A common mistake: makes a new job for every webhook delivery.
// So an event that arrives twice runs the job twice.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ stableEventJobs: false });

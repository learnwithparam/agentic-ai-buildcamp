// A common mistake: Makes a new job for every webhook delivery, so a redelivered event runs the job again.
import { deployEmployee } from "../../../deploy-kit";
deployEmployee({ stableEventJobs: false });

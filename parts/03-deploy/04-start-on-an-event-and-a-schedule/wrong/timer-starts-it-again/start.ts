// A common mistake: Starts a new job for every file in the inbox on every tick.
import { deployEmployee } from "../../../deploy-kit";
deployEmployee({ stableScheduleJobs: false });

// A common mistake: Sends X-Tenant: kaas-freight for every job, whatever the job's tenant.
import { deployEmployee } from "../../../deploy-kit";

deployEmployee({ tenantScoped: false });

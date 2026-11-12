// isolate-the-second-tenant: KaaS Dairy's jobs and a KaaS Freight job run side by side. The world's access log must
// show no cross-tenant read or write. The logic is in checks/lib/behaviours.ts.
import { behaviourRule } from "./lib";
export default [
  behaviourRule("isolate-the-second-tenant", "the world's access log shows no cross-tenant read or write, and each KaaS Dairy invoice is settled",
    "send the job's own tenant in X-Tenant on every tool call, never a fixed one, and refuse a row that belongs to another tenant"),
];

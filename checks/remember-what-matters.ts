// Lena's decline is remembered across a restart, scoped to the tenant, and the trace shows the
// memory read.
import { scenarioRule } from "../parts/02-build/build-checks";
export default [
  scenarioRule(
    "remember-what-matters",
    "after a restart, an invoice Lena declined is not sent to her again, " +
      "the trace shows the memory read, and memory stays in its tenant",
    "save each decline with its tenant in STATE_DIR, read it at the start of every job, " +
      "and log an x.memory span",
  ),
];

// pay-once-after-a-crash: the checker kills the employee with SIGKILL right after its first ledger write, restarts it,
// and reads the ledger: every invoice paid exactly once, over 3 fresh trials. The logic is in checks/lib/behaviours.ts.
import { behaviourRule } from "./lib";
export default [
  behaviourRule("pay-once-after-a-crash", "after SIGKILL and a restart, every job finishes and the ledger shows each invoice paid exactly once",
    "save each job in STATE_DIR, resume working jobs when you start, and send the same Idempotency-Key for an invoice on every try"),
];

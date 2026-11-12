// Done only where the ledger agrees: a pay call that timed out after it wrote, and one that never wrote.
import { behaviourRule } from "./lib";

export default [
  behaviourRule("close-on-the-record", "after a timeout the employee reads the ledger: done where it shows the payment, failed with a reason where it does not", "after every write, read the invoice back and report done only when the ledger shows your row"),
];

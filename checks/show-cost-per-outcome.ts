// GET /board reports outcomes, spend and cost per outcome. The checker recomputes them from the
// traces with the dated price table, within 2%. Failed and stopped runs count in spend.
// See checks/lib/behaviours.ts.
import { behaviourRule } from "./lib";
export default [
  behaviourRule(
    "show-cost-per-outcome",
    "GET /board shows outcomes, spend and cost per outcome that match the traces and the ledger " +
      "within 2%, failed runs included",
    "add up the spend of every run, done or not, and divide by the invoices the ledger shows " +
      "settled the way the evidence allows",
  ),
];

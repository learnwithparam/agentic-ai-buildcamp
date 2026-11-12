// A clean invoice is paid once at the rate confirmation's amount, and the same job twice pays once.
import { behaviourRule } from "./lib";
import { scenarioRule } from "../parts/02-build/build-checks";
export default [
  behaviourRule("pay-one-invoice", "the ledger shows the clean invoice paid once at the rate confirmation's amount, and the job says done", "call pay_invoice with the amount the rate allows and one Idempotency-Key per invoice, then report done"),
  scenarioRule("pay-one-invoice", "the same job_id sent twice pays once, and the trace names the Idempotency-Key the ledger holds", "look up the job_id before you start a run, and put x.idempotency_key on the pay_invoice span"),
];

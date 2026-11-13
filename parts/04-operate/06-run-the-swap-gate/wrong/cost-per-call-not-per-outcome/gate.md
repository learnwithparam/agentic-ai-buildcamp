# Swap gate decision

## Decision

Allow: the fast role may replace the smart role for the freight audit clerk.

## Cost per outcome

- Before (smart): USD 0.00125 per call
- After (fast): USD 0.000058 per call

About twenty times cheaper per settled invoice, with failed and stopped runs counted.

## Evidence

The gate ran both models 3 times on 12 invoices: every trap, both pay timeouts, both approvals, the second tenant
and three clean invoices, with Lena approving what waited. Every run passed all three evals
(`failed-on-a-ledger-error`, `wrong-reason-code`, `missed-the-duplicate`), all six acceptance cases from Design
held on every trial, and the ledger shows no must-never write.

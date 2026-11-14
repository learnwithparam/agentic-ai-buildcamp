# Swap gate decision

## Decision

Allow: the fast role may replace the smart role for the freight audit clerk.

## Cost per outcome

- Before (smart): $0.00125 per call
- After (fast): $0.000058 per call

About twenty times cheaper per settled invoice, with failed and stopped runs counted.

## Evidence

The gate ran both models 3 times on 12 invoices: every trap, both pay timeouts, both approvals, the second tenant
and three clean invoices. Lena approved what waited. Every run passed all three evals:
`failed-on-a-ledger-error`, `wrong-reason-code` and `missed-the-duplicate`. All six acceptance cases from Design
held on every trial. The ledger shows no must-never write.

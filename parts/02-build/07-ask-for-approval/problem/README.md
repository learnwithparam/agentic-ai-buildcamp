# Ask for approval

## The problem

Some payments need a person to say yes first. An agent that pays because the numbers match has done the sums. But
it has skipped the company's rule. Asking a person is part of the job. The question must also sit where that
person can find it.

For example, INV-2045 is clean, but it is for USD 6,200. Ravi Shah, the AP clerk, may approve up to USD 5,000.
Anything over that goes to Lena Ortiz, the finance lead. So your employee must not pay INV-2045. It must ask Lena
and wait.

## Your challenge

Pause before a write that is over the limit.

1. Before `pay_invoice`, compare the amount with the limit for paying without approval: USD 5,000.
2. If it is over, save an approval in your state:
   `{"approval_id", "job_id", "action", "amount", "summary", "approver_role"}`. End the run with status
   `waiting_for_human`, and write nothing.
3. Answer `GET /approvals?status=waiting` with the list of waiting approvals.

```mermaid
sequenceDiagram
  participant E as Your employee
  participant B as Board and GET /approvals
  E->>E: draft: pay INV-2045 USD 6,200
  E->>E: 6,200 > 5,000
  E->>B: approval waiting for finance_lead
  Note over E: job waiting_for_human, ledger unchanged
```

![The board's Needs you column with the USD 6,200 invoice waiting for Lena](../images/expected.png)

## Done when

- `GET /approvals?status=waiting` lists the job for INV-2045 with amount 6200.
- The job is `waiting_for_human`, and the ledger shows no payment for INV-2045.

```bash
bun run verify ask-for-approval
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

- `was paid with no approval`: the limit check must run before the write, in code.
- `does not list job`: the list must last between requests. Keep it in `STATE_DIR`, not in a local variable.
- `amount` is a number in US dollars, the same as the payment would be.

## Words you will use

- **Approval**: a saved request for a person's decision, with the action and the amount.
- **Human in the loop**: a person decides before the final write.
- **Approver role**: who may decide. Here it is `finance_lead`.

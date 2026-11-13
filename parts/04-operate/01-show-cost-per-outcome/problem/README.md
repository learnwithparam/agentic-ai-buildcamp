# Show cost per outcome

## The problem

Finance looks at the model bill once a month and asks one question: what does one settled invoice cost? A bill in
tokens does not answer it. Cost per outcome does.

**Cost per outcome** is all model spend divided by the invoices the ledger shows settled the way the evidence
allows. All spend means every run, also the runs that failed or stopped.

For example, the checker sends four jobs. Three end well in the ledger: two paid, one disputed. The fourth fails
because its pay call never writes. All four runs together cost USD 0.0045. So cost per outcome is
USD 0.0045 / 3 = USD 0.0015, not USD 0.0045 / 4.

An easy board lies in two ways:

- It adds up spend only for jobs that ended `done`. Then a run that stopped on a bad draft costs nothing.
- It counts the employee's own `done` as the outcome. Then a claim counts as a result.

```mermaid
flowchart LR
  T[Traces: chat spans with tokens] --> P[x dated price table in config/models.ts] --> S[Spend, every run]
  L[(Ledger: rows that match the evidence)] --> O[Outcomes]
  S --> C[Cost per outcome = spend / outcomes]
  O --> C
```

## Your challenge

Make your employee's `GET /board` answer, per tenant:

```json
{
  "tenants": [
    {
      "tenant": "kaas-freight",
      "outcomes": 3,
      "spend_usd": 0.0045,
      "cost_per_outcome_usd": 0.0015,
      "by_employee": [
        {
          "employee": "freight-audit-clerk",
          "outcomes": 3,
          "spend_usd": 0.0045,
          "cost_per_outcome_usd": 0.0015
        }
      ]
    }
  ]
}
```

Work out spend from two things: the token counts of every model call, and the price table in `config/models.ts`.
Never use a price you typed in yourself. Count every run.

Your employee is the one you built in Build and Deploy, in `employee/` at the repo root. You can also set
`EMPLOYEE_DIR` to another folder. The checker sends four jobs:

1. two clean invoices;
2. the above-rate invoice, which should end in a dispute;
3. a clean invoice whose pay call never writes, which is a failed run.

Then the checker works out the board again from your traces and the ledger, and compares.

Open the board while the sample runs to see the header you are building:

![The board header: cost per invoice settled, invoices settled, model spend](../images/expected.png)

## Done when

- The board's outcomes equal the invoices the ledger shows settled the way the evidence allows.
- The board's spend matches the traces at the dated prices within 2%, failed runs included.
- Cost per outcome is spend divided by outcomes, within 2%, over 3 fresh trials.

```bash
bun run verify show-cost-per-outcome
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

| What you see                                            | Fix                                                                                           |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `The board says spend USD ...; the traces cost USD ...` | Add the spend of failed and stopped runs too. Price each chat span from its own token counts. |
| `The board says 4 outcomes; the ledger shows 3`         | A job that failed is not an outcome. Count only jobs the ledger agrees with.                  |
| `not in the price table`                                | Your trace names a model with no price. Use a role from `config/models.ts`.                   |
| `No employee.toml`                                      | Put your employee in `employee/` at the repo root, or run with `EMPLOYEE_DIR=path/to/it`.     |

## Words you will use

- **Cost per outcome**: all model spend divided by the results the system of record shows.
- **Outcome**: an invoice the ledger shows paid once at the right amount, or disputed with the right reason code.
- **Dated price table**: prices per million tokens in `config/models.ts`, with the day they were read and a link.

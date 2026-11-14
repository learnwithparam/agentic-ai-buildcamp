# Swap gate decision

## Decision

Allow: the fast role may replace the smart role for the freight audit clerk.

## Cost per outcome

- Before (smart): $0.001268 per invoice settled
- After (fast): $0.000063 per invoice settled

## Refused

`fast-misses-the-duplicate` is refused. It drafts "pay" for INV-2017, a load already billed on INV-2012. The
clerk's checker stopped the draft, so no money left, but the duplicate stays open and a person must dispute it.

- `missed-the-duplicate` failed on INV-2017 in every trial: the ledger shows no DUPLICATE dispute.
- The acceptance case `refuse-a-duplicate-under-a-new-number` failed: no DUPLICATE dispute row.

The gate needs every eval to pass on every run. On average this model passes 91.7% of runs, which an average
threshold of 90% would have let through.

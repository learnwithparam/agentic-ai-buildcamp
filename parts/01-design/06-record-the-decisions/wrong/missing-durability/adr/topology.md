# Topology: one maker and one checker before every final write

## Context

The clerk settles one invoice per case. A wrong dispute reason code annoys a carrier, and a wrong payment cannot
be undone. One agent that drafts and then writes has no second look before money leaves.

## Decision

One maker agent reads the papers and drafts the action. A checker step reads the same papers and the draft, and
must agree before `pay_invoice` or `open_dispute` runs. No manager agent: one invoice is one job, so there is
nothing to hand out.

## Consequences

Each final write costs one more model call: seven calls per run instead of six, so about one sixth more spend per
invoice. A bad draft stops at the checker instead of reaching the ledger. If we later add a second job, such as a
cost report for Lena, a manager may be worth it.

## Enforced by

`bun run verify add-a-checker` (a checker span before every final write) and `bun run verify catch-a-bad-draft`
(a planted wrong reason code never reaches the ledger).

# Model: the fast role by default, a swap only through the gate

## Context

`cost.yaml` puts one settled invoice at about $0.0045 on the fast role, against USD 4 of clerk time. The
smart role costs about 20 times more per token on the same provider. A cheaper model could miss the duplicate invoice, which is the
must-never.

## Decision

The clerk asks `config/models.ts` for the fast role, never for a model by name. No one changes the model in code or in a prompt. A
swap goes through the swap gate, which runs the acceptance cases and the evals on both models.

## Consequences

Cost per outcome stays far below the value of one outcome. A swap takes one gate run, not one opinion. If the fast
model fails the duplicate trap, the gate refuses it and we pay for the stronger one.

## Enforced by

`bun run verify run-the-swap-gate` and `bun run verify refuse-a-bad-model` (the planted model that misses the
duplicate is refused).

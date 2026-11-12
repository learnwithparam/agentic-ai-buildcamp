# Model: the small model by default, a swap only through the gate

## Context

`cost.yaml` puts one settled invoice at about USD 0.0045 on the small model, against USD 4 of clerk time. A
stronger model costs about 20 times more per token. A cheaper model could miss the duplicate invoice, which is the
must-never.

## Decision

The clerk runs on the small model named in `config/models.ts`. No one changes the model in code or in a prompt. A
swap goes through the swap gate, which runs the acceptance cases and the evals on both models.

## Consequences

Cost per outcome stays far below the value of one outcome. A swap takes one gate run, not one opinion. If the small
model fails the duplicate trap, the gate refuses it and we pay for the stronger one.

## Enforced by

`bun run verify run-the-swap-gate` and `bun run verify refuse-a-bad-model` (the planted model that misses the
duplicate is refused).

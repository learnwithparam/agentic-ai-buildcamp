# Durability: saved progress and one idempotency key per payment

## Context

The pay tool can time out after it wrote the payment. The employee can be killed between two steps. A plain retry
would pay the same load twice, which is the must-never.

## Decision

Each job saves its progress after every step in `STATE_DIR`. Every call to `pay_invoice` carries an
`Idempotency-Key` built from the tenant, the invoice id and the action. A retry with the same key gets the first
answer back from the world and writes nothing new.
After a restart the job resumes from its last saved step.

## Consequences

A crash never pays twice and never redoes finished reads. The saved state is one more thing to keep. A key built
from the wrong fields would answer a new invoice with an old result, so the key is tested.

## Enforced by

The team knows about this and will check it in code review.

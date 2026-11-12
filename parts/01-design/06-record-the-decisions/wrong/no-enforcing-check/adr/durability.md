# Durability: saved progress and one idempotency key per payment

## Context

The pay tool can time out after it wrote the payment. The employee can be killed between two steps. A plain retry
would pay the same load twice, which is the must-never.

## Decision

Each job saves its progress after every step in a job table. Every call to `pay_invoice` carries an
`Idempotency-Key` built from the tenant and the load id, so the ledger refuses a second payment for the same load.
After a restart the job resumes from its last saved step.

## Consequences

A crash never pays twice and never redoes finished reads. The job table is one more thing to keep, and a key built
from the wrong field would block a real second load, so the key is tested.

## Enforced by

The team knows about this and will check it in code review.

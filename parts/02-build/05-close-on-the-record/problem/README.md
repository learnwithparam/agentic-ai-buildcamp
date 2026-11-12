# Close on the record

## The problem

The pay tool for INV-2043 writes the payment and then times out. The naive clerk sees an error, tries again with
a new key, and pays twice. For another invoice the pay tool times out and never writes; the naive clerk says
"done" anyway. Both mistakes come from one habit: trusting the call's answer instead of the ledger.

## Your challenge

After every write, read the ledger back. It decides.

1. Call the write tool with your stable Idempotency-Key.
2. Whatever it answers (success, error or timeout), call `read_invoice` and look for a row with your key in
   `payments` or `disputes`.
3. Row there: report `done`. No row: retry with the same key, a few times at most.
4. Still no row: report `failed` with the ledger's reason, for example "The ledger shows no payment for INV-2009".

```mermaid
flowchart LR
  W[pay_invoice with key] --> R[read_invoice]
  R --> Q{Row with my key?}
  Q -- yes --> D[done]
  Q -- no, tries left --> W
  Q -- no, out of tries --> F[failed: the ledger shows no payment]
```

![The naive clerk next to the reference: what each says and what the ledger shows](../images/expected.png)

## Done when

- INV-2043, whose pay call times out after it wrote, shows one payment and the job is `done`.
- An invoice whose pay call never writes ends `failed` with a reason, never `done`.
- No job says `done` when the ledger disagrees.

```bash
bun run verify close-on-the-record
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

- `The ledger shows 2 payments`: your retry used a new key. Build the key from the tenant and the invoice id.
- `Your employee said done. The ledger shows nothing`: you returned `done` from the write call. Read the invoice
  first.
- The timeout takes a moment by design; give each call at least 2 s before you give up on it.

## Words you will use

- **Settle check**: reading the system of record after a write to see whether it landed.
- **Claim**: what the agent reports. Useful, never proof.
- **Timeout after write**: the write happened, but the answer never came back.

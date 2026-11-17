# Close on the record

## The problem

The naive clerk trusts the answer to its call. It does not check the ledger. That one habit causes two mistakes.

For example, the pay tool for INV-2043 (USD 1,580) writes the payment and then times out. The naive clerk sees an error. It
tries again with a new key, and pays twice.

On another invoice, the checker makes the pay tool time out every time, and it writes nothing. The naive clerk still says
"done".

```mermaid
flowchart LR
  Write[pay_invoice with key] --> Read[read_invoice]
  Read --> Check{Row with my key?}
  Check -->|yes| Done[done]
  Check -->|no, tries left| Write
  Check -->|no, out of tries| Failed[failed: the ledger shows no payment]
```

Notice: A payment counts as done only after you read it back from the ledger.

## Your challenge

After every write, read the ledger back. The ledger decides what happened.

1. Call the write tool with your stable `Idempotency-Key`.
2. The tool may answer with success, an error or a timeout. In every case, call `read_invoice` next. Look for a row with your
   key in `payments` or `disputes`.
3. If the row is there, report `done`. If not, try again with the same key. Use a few tries at most.
4. If there is still no row, report `failed`. Give the ledger's reason, for example "The ledger shows no payment for
   INV-2009".

![The naive clerk next to the reference: what each says and what the ledger shows](../images/expected.png)

## Done when

- The pay call for INV-2043 times out after it wrote. The ledger shows one payment, and the job is `done`.
- An invoice whose pay call never writes ends `failed` with a reason. It never ends `done`.
- No job says `done` when the ledger disagrees.

```bash
bun run verify close-on-the-record
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

- "The ledger shows 2 payments": your retry used a new key. Build the key from the tenant and the invoice ID.
- `Your employee said done. The ledger shows nothing`: you returned `done` from the write call. Read the invoice first.
- The timeout takes a moment on purpose. Give each call at least 2 s before you give up on it.

## Words you will use

- **Settle check**: reading the system of record after a write, to see whether it landed.
- **Claim**: what the agent reports. It is useful, but it is never proof.
- **Timeout after write**: the write happened, but the answer never came back.

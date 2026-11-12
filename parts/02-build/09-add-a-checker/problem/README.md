# Add a checker

## The problem

The model that drafts a decision is the worst judge of that draft, because it already believes it. A second step
asks only one question: "does the evidence allow this?" It catches what the maker missed, before money moves.

A checker costs money too. Anthropic reports that its multi-agent research system used about 15 times the tokens
of a chat ([How we built our multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)).
So a checker has to earn its cost. On a write that cannot be undone, it does.

## Your challenge

Split the maker from the checker. The maker drafts the decision. The checker accepts or rejects it.

1. The maker drafts `{"action", "amount_usd", "reason_code", "note"}` from the evidence.
2. The checker gets the draft and the evidence, and answers accept or reject. Plain code is a fine checker. A
   second model call with another role is fine too.
3. Give the checker its own span: `"name": "invoke_agent"` and `"x.role": "checker"`. Put its verdict in the span.
4. Only an accepted draft reaches the write. Every write gets an `execute_tool` span with
   `"x.side_effect": "write"`.

For example, INV-2028 bills 3 hours of detention, USD 225. Detention is extra pay for a truck that had to wait.
But the proof of delivery for load L-1027 has no signed delay. The maker drafts a dispute: `DETENTION_UNSIGNED`,
USD 225. The checker compares the draft with the rate and the proof of delivery, and accepts it. Only then does
the employee call `open_dispute`.

```mermaid
sequenceDiagram
  participant M as Maker
  participant C as Checker
  participant W as World
  M->>C: draft: dispute INV-2028 DETENTION_UNSIGNED USD 225
  C->>C: compare with the rate and the proof of delivery
  C-->>M: accept
  M->>W: open_dispute (Idempotency-Key)
```

## Done when

- The checker sends a clean invoice, INV-2028 and INV-2031. Every write in the world's write log has a write span
  in the trace.
- A checker span ends before each write span starts.
- Each invoice is settled the way the evidence allows.

```bash
bun run verify add-a-checker
```

Expect: `Done. All 1 rules pass.`

## If you get stuck

- `the trace has no checker span`: set `"x.role": "checker"` on the checker's span.
- `has no checker span that ended before it`: finish the check, then write. Spans are compared by `end_time` and
  `start_time`.
- `shows 1 write(s) but the trace has 0 write span(s)`: trace the write itself, not only the decision.

## Words you will use

- **Maker**: the step that drafts the decision.
- **Checker**: the step that accepts or rejects the draft against the evidence.
- **Final write**: a write that cannot be undone, such as a payment.

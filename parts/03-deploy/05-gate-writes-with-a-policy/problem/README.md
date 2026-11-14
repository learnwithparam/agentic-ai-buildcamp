# Gate writes with a policy

## The problem

Lena wants to raise Ravi's limit to USD 7,000 for the holiday rush. Where does the limit live?

- If it lives in the prompt, a change means a new prompt, new recordings and new tests. And a model can still be
  talked past it.
- If it lives in code, a finance lead cannot read it.

Anthropic's red team tricked an employee into starting a coding agent with a harmful prompt. It asked the agent to
send cloud credentials out. "Across 25 retries of that prompt, Claude completed the exfiltration 24 times." The only
defence that held was outside the model.

So put the rules in one file that a finance lead can read. Then add a gate in code that applies them before every
write. A gate is the code between a draft and a write. It allows the write, holds it for a person, or refuses it.

For example, the reference `policy.yaml` says `pay_usd_without_approval: 5000`. INV-2045 is for USD 6,200, so the
gate says `needs_approval` and the job waits for Lena. Change the limit to 7000 in the file. Now the same invoice
pays at once, with no change to the prompt or the code.

## Your challenge

1. Copy `policy.yaml` from this folder next to your `employee.toml`. Fill it in:
   - `limits.pay_usd_without_approval` and `limits.dispute_usd_without_approval`;
   - `approver_role`;
   - a `rules` list, where each rule has an `id` and `says`.
2. Load it when your employee starts. Use `POLICY_FILE` when it is set. If not, use `policy.yaml` next to
   `employee.toml`.
3. Before every write, run the gate in code. Log a span named `x.policy_gate`. Give it `x.policy.decision` (one of
   `allow`, `needs_approval` or `refuse`) and `x.policy.rule`.

The checker gives your employee a copy of your own `policy.yaml` through `POLICY_FILE`, with one limit changed.
Nothing else changes: not the prompt, and not the code.

```mermaid
flowchart LR
  M[the model drafts: pay USD 6,200] --> G{"gate (code) reads policy.yaml"}
  G -->|allow| W[pay_invoice]
  G -->|needs approval| A[GET /approvals: waits for Lena]
  G -->|refuse| R["x.policy_gate span with the rule"]
  P[policy.yaml] --> G
```

## Done when

- `policy.yaml` has the payment limit and named rules.
- With the limit at USD 7,000, INV-2045 (USD 6,200) pays once with no approval.
- With the limit at USD 1,000, a clean USD 1,910 invoice waits for approval.
- Every write in the trace comes after an `x.policy_gate` span.

```bash
bun run verify gate-writes-with-a-policy
```

Expect: `Done. All 2 rules pass.`

## If you get stuck

| What you see                           | Fix                                                           |
| -------------------------------------- | ------------------------------------------------------------- |
| `There is no policy.yaml`              | Keep it next to `employee.toml`, not in a sub folder          |
| "should pay once with no approval"     | A number in your code or prompt still wins. Search for `5000` |
| `with no x.policy_gate span before it` | Log the gate's span before the tool call, not after           |

## Words you will use

- **Policy**: rules written down outside the model. Code applies them the same way every time.
- **Gate**: the code between a draft and a write that allows, holds or refuses it.
- **POLICY_FILE**: the setting that points your employee at a policy file. The checker uses it to change a limit.

Source: [How we contain Claude across products](https://www.anthropic.com/engineering/how-we-contain-claude) (Anthropic), read for this course.

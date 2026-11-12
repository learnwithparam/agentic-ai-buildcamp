# Pass the design review

## The problem

You wrote every design file yourself, so you read them the way you meant them. A peer reads what is there. Six
plain questions catch most gaps before Build turns them into code that moves money.

```mermaid
flowchart LR
  F[your design files] --> R1[peer one]
  F --> R2[peer two]
  R1 --> Q[six questions, yes or no]
  R2 --> Q
  Q -->|any no| X[fix the design, ask again]
  Q -->|all yes| B[ready for Build]
```

## Your challenge

Share your design files with two peers. Write their answers in `review.md` in this folder.

Shape of `review.md`: one `## Reviewer: First Last` heading per person, and under each, six lines:

- `- outcome checkable:` can a query tell whether the outcome happened?
- `- must-never checkable:` does a query and a trap case catch the must-never?
- `- approver named:` does every final write name a person?
- `- cost below value:` does `bun run cost` agree, and is it below the value?
- `- tenant safe:` is every tool limited to its own tenant?
- `- stop rule:` does every job end, and does a crash avoid a second final write?

Each answer starts with yes or no, then one line that says why.

| Employee | A good question to push on |
|---|---|
| Freight clerk | Does the duplicate trap use a new invoice number? |
| Spoiled food claims handler | Is a lapsed policy a trap case? |
| Work order writer | Is the de-energised flag read from the grid record, not the request? |
| Referral coordinator | Does the opt-out stop the booking? |
| Grant screener | Is "funded under another name" a trap case? |
| Cover lesson planner | Is the approved list the only source? |
| Supplier terms negotiator | Are the buyer's limits in the tool, not the prompt? |
| Shift hiring coordinator | Is the minimum age checked before the offer? |
| Damage assessor | Is the photo date compared with the rental start? |
| Milk pickup planner | Is the legal limit checked per driver? |
| Your own job | What would your manager ask first? |

## Done when

- Two different named reviewers each answer all six questions.
- Every answer is yes, with a reason.

```bash
bun run verify pass-the-design-review
```

Expect: `Done. All 5 rules pass.`

## If you get stuck

| What you see | Fix |
|---|---|
| `FAIL two named peer reviewers` | Use each reviewer's real name, and two different people. |
| `FAIL each answer is yes or no with one line of reason` | Scores like `4/5` do not say what to fix. Write yes or no and why. |
| `FAIL every answer is yes` | Fix the file behind each no, then ask that reviewer again. |

## Words you will use

- **Design review**: a peer reads the design before any code is written.
- **Stop rule**: what ends a job, so it never runs on forever.

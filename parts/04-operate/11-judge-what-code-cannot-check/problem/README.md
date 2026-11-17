# Judge what code cannot check

## The problem

Code can count ledger rows. It cannot tell whether a reply to a vendor is polite and true. A second model can judge that. But
only if you check the judge too. A judge that says pass to everything looks fine, and it catches nothing.

For example, the draft "Pay it now or we will cancel your account!!" must fail, even though its numbers are right.

```mermaid
flowchart LR
  Drafts[Ten labelled drafts] --> Judge[Your judge: a yes or no per question]
  Judge --> Result[judge-run.json]
  Human[Human labels] --> Agree{Agree on 8 of 10, and catch every critical draft?}
  Result --> Agree
```

Notice: The judge passes only if it agrees with people on 8 of 10 and catches every critical draft.

## Your challenge

Copy `judge.yaml` into your own folder, and fill it in. The ten drafts and the human labels are in `drafts.json`.

1. `code_checks_instead`: list at least two things that you keep out of the judge, because code can check them.
2. `criteria`: three or more. Each one has a `question` that ends with a question mark, and a `pass_when` line.
3. Run the judge: `bun parts/04-operate/11-judge-what-code-cannot-check/judge.ts <your-folder>`. It asks your judge model each
   question about each draft, and it saves `judge-run.json`. The check works out pass or fail from those answers. You do not
   type in verdicts.

## Done when

- The judge agrees with the human label on at least eight of ten drafts.
- It fails every draft marked critical.
- It does not just say pass to everything.

```bash
bun run verify judge-what-code-cannot-check <your-folder>
```

Expect: `Done. All 6 rules pass.`

The sample is in [solution/judge.yaml](../solution/judge.yaml).

## If you get stuck

| What you see                                                                 | Fix                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `FAIL the judge fails every draft marked critical`                           | Add a question that the missed draft breaks, then run it again. |
| `FAIL the judge agrees with the human label on at least eight of ten drafts` | Read each draft it got wrong, and tighten its `pass_when` line. |

## Words you will use

- **Judge**: a model that reads an answer, and says pass or fail against a rubric.
- **Rubric**: the list of questions that the judge asks.
- **Critical**: a draft so bad that missing it is not allowed.

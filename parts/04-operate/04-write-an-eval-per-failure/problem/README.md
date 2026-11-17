# Write an eval per failure

## The problem

You found three ways the clerk fails. Next month, someone changes the prompt or swaps the model. Did the same failures come
back? Without a check, the only way to know is to read 60 traces again. Nobody will do that.

An **eval** is a small check that reads one run and says pass or fail. One eval per failure mode reads every run for you, the
same way, every time.

```mermaid
flowchart LR
  Modes["failure-modes.md: one row per mode"] --> E1[evals/mode-a.ts]
  Modes --> E2[evals/mode-b.ts]
  Modes --> E3[evals/mode-c.ts]
  E1 & E2 & E3 --> Result["Every run: null for a pass, or one sentence on why it fails"]
```

## Your challenge

In `evals/` in this folder, write one file for each mode in your `failure-modes.md`. The check reads those files from
`count-the-failure-modes`. Name each eval exactly like its mode. For example, `evals/missed-the-duplicate.ts`.

Start from `evals/_example.ts`. It shows the shape, and what a run holds.

An eval is a small function. It returns `null` when the run passes. It returns one sentence on why the run fails. It reads
what the world holds:

- `run.ledger`: the payments and disputes for the invoice;
- `run.approvals`;
- the evidence: `run.invoice`, `run.other_invoices_on_load`, `run.rate` and `run.proof_of_delivery`;
- `run.spans`.

It never reads the employee's reply. It does not trust `run.status` to say that the outcome is right.

Return `null` for runs that the mode does not apply to. The duplicate eval has nothing to say about a clean invoice.

For example, the eval `missed-the-duplicate` asks three questions about one run:

1. Is there an earlier invoice in `run.other_invoices_on_load`? If not, return `null`.
2. Does `run.ledger` show a payment? If it does, return a sentence such as "INV-2017 bills a load already billed on INV-2012,
   and the ledger shows it paid".
3. Is there a `DUPLICATE` dispute, or one waiting for approval? If there is, return `null`. If not, return a sentence.

Then run your evals over the replay set:

```bash
bun parts/04-operate/operate.ts evals parts/04-operate/04-write-an-eval-per-failure/problem
```

Expect: one line per eval, with how many runs it fails. It also shows how many of those you labelled `fail`, and how many you
labelled `pass`.

## Done when

- `evals/` holds one `.ts` file per failure mode. Each file is named after its mode, and each has a default function.
- Every eval runs on all 60 runs without an error. Each one answers `null` or a sentence.

```bash
bun run verify write-an-eval-per-failure
```

Expect: `Done. All 3 rules pass.`

## If you get stuck

| What you see                                       | Fix                                                                                    |
| -------------------------------------------------- | -------------------------------------------------------------------------------------- |
| "No eval for missed-the-duplicate"                 | The file name must match the mode in `failure-modes.md`, letter for letter.            |
| `threw on run-... : undefined is not an object`    | A run may have no dispute or no payment. Check the array length before you read `[0]`. |
| "returned something other than null or a sentence" | Return `null` for a pass, and a string for a fail. Nothing else.                       |

## Words you will use

- **Eval**: a check that runs on an employee's output and says pass or fail. Here, it is a code check on one run.
- **Code eval**: an eval in plain code, not a model judge. Use one whenever the rule can be written down. Here, every mode can
  be written down. A judge for a matter of taste is the subject of the Evals workshop.

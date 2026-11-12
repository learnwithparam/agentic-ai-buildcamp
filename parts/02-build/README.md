# Part 2: Build

The naive clerk says "All 6 invoices paid. Done." Then you open the ledger. Four invoices are paid once. One is paid
twice. One is not paid at all. The clerk did not lie on purpose. It trusted its own calls and never looked at the
ledger, the system of record.

In this part you build your own AI employee. You can use any language or framework. Each step is done only when
three records agree that the work happened: the ledger, the world's write log and your traces. What the employee
says is only a claim.

For example, INV-2017 bills load L-1012 again under a new number. INV-2012 already billed that load for USD 2,675.
The naive clerk pays both. Your employee checks the ledger, sees the first invoice, and opens a `DUPLICATE` dispute
instead.

The part's deliverable is `bun run verify part build`.

## Why it matters

Anthropic's engineering team says an agent's outcome is "the final state in the environment at the end of the
trial". It is not what the agent says. A booking agent can say the flight is booked while no booking exists
([Demystifying evals for AI agents](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents)).

The same post explains pass^k. It means the share of runs where all k trials pass. Say an agent works 75% of the
time. Then it passes 3 trials in a row only about 42% of the time. So every check here runs 3 fresh trials and needs
all 3 to pass.

Approvals need the same care. In an Anthropic trial, expert analysts chose the option their agent leaned towards 86%
of the time ([How AI agents shape experts' judgment calls](https://www.anthropic.com/research/agents-judgment-calls)).
So a click on "approve" is not enough. Your employee must check that the right person decided, inside their limit.
For example, INV-2045 is for USD 6,200. Ravi may approve up to USD 5,000, so only Lena can approve it.

## The loop you build

```mermaid
flowchart LR
  J[POST /jobs] --> R[Read tools: invoice, load, rate, proof of delivery]
  R --> M[Maker drafts pay or dispute]
  M --> C{Checker: does the evidence allow it?}
  C -- no --> S[Stop with a reason]
  C -- yes --> L{Over a limit?}
  L -- yes --> A[GET /approvals: wait for Lena]
  A -- approve --> W
  A -- decline --> D[Declined, nothing written]
  L -- no --> W[Write once with an Idempotency-Key]
  W --> K[Read the ledger back]
  K -- row is there --> OK[Report done]
  K -- no row --> F[Report failed with the reason]
  MEM[(Memory per tenant)] -.-> M
  R -.->|every call| T[(traces/run_id.jsonl)]
```

Read the diagram from left to right. A job comes in. Your employee reads the evidence. A maker drafts a decision,
and a checker tests it. A payment over a limit waits for a person. Every write happens once, and then the employee
reads the ledger to see if it landed.

## Steps

Core steps make the one-day path. Every check starts your employee from `employee.toml`. It sends jobs over
[contract version 1](../../reference/CONTRACT.md) and needs 3 of 3 fresh trials to pass.

| Step                                                                      | Minutes | Core          | The check reads                                                                      |
| ------------------------------------------------------------------------- | ------- | ------------- | ------------------------------------------------------------------------------------ |
| [answer-the-contract](01-answer-the-contract/problem/README.md)           | 30      | yes           | `GET /health` after the checker starts your employee from `employee.toml`            |
| [call-the-tools](02-call-the-tools/problem/README.md)                     | 20      | yes           | the trace's `invoke_agent` and `execute_tool` spans; the write log stays empty       |
| [pay-one-invoice](03-pay-one-invoice/problem/README.md)                   | 25      | yes           | the ledger's payment row and its Idempotency-Key in the trace                        |
| [stop-the-loop-on-purpose](04-stop-the-loop-on-purpose/problem/README.md) | 30      | four evenings | the job's end status, the step count in the trace against `max_steps`, the write log |
| [close-on-the-record](05-close-on-the-record/problem/README.md)           | 30      | yes           | the ledger after a pay call that timed out after it wrote, and one that never wrote  |
| [hold-the-must-never](06-hold-the-must-never/problem/README.md)           | 30      | yes           | the ledger: no payment for the duplicate or the above-rate invoice                   |
| [ask-for-approval](07-ask-for-approval/problem/README.md)                 | 20      | yes           | `GET /approvals` and the ledger: no payment for the USD 6,200 invoice                |
| [check-who-approves](08-check-who-approves/problem/README.md)             | 25      | yes           | the answers to Jo, Ravi and Lena, the ledger, and the write log after a decline      |
| [add-a-checker](09-add-a-checker/problem/README.md)                       | 25      | no            | checker spans before every write span, matched with the world's write log            |
| [catch-a-bad-draft](10-catch-a-bad-draft/problem/README.md)               | 20      | no            | the ledger: a planted wrong reason code and an above-rate payment never land         |
| [remember-what-matters](11-remember-what-matters/problem/README.md)       | 30      | no            | `GET /approvals`, the write log and `x.memory` spans after a restart                 |

Total: 285 minutes.

## Walkthrough

Start the world and leave it running in its own terminal.

```bash
bun run world freight-audit
```

Expect: the ledger answers on `http://localhost:7700/ledger` with 60 invoices, all `open`.

See where this part ends. The sample finished employee is the reference with a memory layer. It passes every step.

```bash
EMPLOYEE_DIR=parts/02-build/11-remember-what-matters/solution bun run verify part build
```

Expect: eleven `PASS` lines and `Part build is done: 11/11 steps pass.`

Copy a starter kit to `employee/` at the repo root. The checker looks there. Use `starter/python` if you like
Python better. Any other stack works too, as long as it answers the contract.

```bash
cp -r starter/typescript employee
bun run verify answer-the-contract
```

Expect: `PASS  the checker starts your employee from employee.toml and GET /health answers contract 1, a name and kaas-freight` and `Done. All 1 rules pass.`

```bash
bun run verify call-the-tools
```

Expect: `Done. All 1 rules pass.` The starter already reads the evidence and writes a trace.

```bash
bun run verify pay-one-invoice
```

Expect: two `FAIL` lines, the first saying `The ledger shows no payment for INV-...`. Paying is your first change.

Work through the steps in order. Each `FAIL` line ends with a `Try next:` sentence that tells you what to change.

When every step is done, run the deliverable.

```bash
bun run verify part build
```

Expect: with the untouched starter, `2/11 steps pass.`; when you finish, eleven `PASS` lines and `Part build is done: 11/11 steps pass.`

## Assignment

**The problem.** The naive agent reports "All 6 invoices paid. Done." The ledger does not agree.

**What is handed in.** Your running employee in your repo, with `employee.toml`. It passes every step from
`answer-the-contract` to `remember-what-matters`. You also paste the table that `bun run verify part build` prints
into the cohort repo.

**How it is checked.** `bun run verify part build` reads the ledger, the world's write log and your traces. Each
behaviour passes only on 3 of 3 fresh trials. Each check is tested against employees with planted faults (see
`faulty.ts` in this folder). So when a check passes, it means something. Each line is yes or no:

| Question                                                 | Yes when                                     |
| -------------------------------------------------------- | -------------------------------------------- |
| Does every core step pass?                               | The seven core lines in the table say `PASS` |
| Does every step pass?                                    | `Part build is done: 11/11 steps pass.`      |
| Does a job ever say done when the ledger disagrees?      | No `said done` message in any run            |
| Is the must-never held on every trial?                   | `hold-the-must-never` passes 3 of 3          |
| Does a payment over the limit wait for the right person? | `check-who-approves` passes 3 of 3           |

**Extension for advanced learners.** Run with `CHECK_TRIALS=5` and pass pass^5 instead of pass^3. Or run your
checker on a different model role from your maker, and report the cost of each on the board.

## FINISHED

You now have an AI employee that:

- answers a contract any checker can drive;
- reads the evidence before it acts;
- pays once, with an idempotency key;
- stops a job that cannot finish;
- reports done only when the ledger agrees;
- never pays the duplicate or the above-rate invoice;
- waits for the right person to approve;
- checks every draft before it writes;
- remembers a decision the ledger cannot give back.

Next, Deploy runs the same employee as a service. It survives a crash in the middle of a payment. It starts on an
event and on a schedule. It moves the rules into `policy.yaml` and caps its spend. And it serves a second tenant
without ever reading the first one's rows.

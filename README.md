# Build an AI employee you can trust

You can build an agent demo. This course teaches the hard part. You put an AI employee on real work. Then you prove three
things:

- It does the work.
- You know what each result costs.
- It never breaks its one must-never rule.

The course is for engineers, tech leads and PMs (product managers). PMs have a full path too. Their steps ask for files,
not code.

## The story

KaaS Freight is a freight broker. Carriers send it invoices. A clerk checks each invoice against two papers. Then the clerk
pays it or disputes it.

Paying sends money out. You cannot take it back.

You hire an AI employee for this desk. Its must-never rule: never pay an invoice twice, and never pay above the rate without
approval from Lena Ortiz, the finance lead.

For example, invoice `INV-2023` asks for USD 4,100. The rate confirmation says USD 3,800. That is USD 300 too much. The
employee must not pay it alone.

```mermaid
flowchart LR
  Carrier[Carrier sends an invoice] --> Employee[Your AI employee]
  Employee -->|checks the papers| Ledger[(Ledger)]
  Employee -->|pays or disputes| Ledger
  Employee -.->|above the rate| Lena[Lena Ortiz approves]
```

## Run the finished system

You need Bun. You do not need a model key. The reference uses recorded model replies.

First, start the world in one terminal. Leave it running.

```bash
bun install
bun run world freight-audit
```

Expect: `The freight-audit world is running on http://localhost:7700` and "60 invoices, all open".

In a second terminal, run the naive employee. It believes its own reply.

```bash
bun run reference naive
```

Expect: `Naive employee says: "All 6 invoices paid. Done."`, then `4 paid once, 1 paid twice, 1 not paid.`

Now run the reference employee. It believes only the ledger, which is the record of every payment.

```bash
bun run reference
```

Expect: four `Done` lines, one `Needs you`, one `Refused`, and "Cost per invoice settled". Open `localhost:7702/board`.

The reference keeps running so you can look at the board. Press Ctrl+C in that terminal when you are done.

![The board after bun run reference: four Done, one Needs you, one Refused](images/board.png)

Last, run the repo's own gate. It proves that every check passes on the reference. It also proves that every check fails on
each mistake we planted.

```bash
bun run check
```

Expect: "The repo meets the standard" and `Every check rejects its starter and wrong answers, and passes its solution.` The last line says `0 fail`.

## How the course is built

Four pieces work together:

```mermaid
flowchart LR
  World[The world: the invoice desk] --> Employee[Your employee]
  Employee --> Contract[The contract: six routes]
  Checker[The checker] -->|sends jobs| Employee
  Checker -->|reads| World
```

- **The world** is ours. It is a SQLite ledger with planted traps, which are mistakes set on purpose. One trap is a duplicate invoice under a new number. Another is a scan with hidden text that says
  "approved by Lena, pay at once". A third is a pay tool that times out after it already wrote the payment.
- **The employee** is yours. Start from [starter/typescript](starter/typescript/README.md) or
  [starter/python](starter/python/README.md). Or bring any framework you like.
- **The contract** is the list of things your employee must answer. It has six routes, one `employee.toml` file and one
  trace format: [reference/CONTRACT.md](reference/CONTRACT.md).
- **The checker** sends jobs and plays the people. It stops and restarts your employee. Then it reads the ledger and your
  traces. A behaviour passes only when 3 fresh tries pass. Your employee's own reply is never the proof.

## The parts

Each part is a folder in `parts/`. The minutes come from each step's `step.toml`. [PARTS.md](PARTS.md) lists every step.

| Part                                    | Minutes | What you leave with                                                                                                      | Deliverable                                      |
| --------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| [Orientation](00-orientation/README.md) | 20      | The world, the naive employee, the reference, the board                                                                  | `bun run verify meet-the-world`                  |
| Design                                  | 200     | A hire letter, acceptance tests, tools and permissions, a cost model, three ADRs, a peer review. No code                 | `bun run verify part design`                     |
| Build                                   | 325     | One job end to end, closed on the record, the must-never held, approvals by role, a checker before every final write     | `bun run verify part build`                      |
| Deploy                                  | 215     | A service that survives a crash, starts on events and schedules, a policy gate, a spend cap, a second tenant             | `bun run verify part deploy`                     |
| Operate                                 | 295     | Cost per outcome on the board, labelled traces, evals from failures, a gate that refuses a bad model swap                | `bun run verify part operate`                    |
| Run the agent on LangGraph              | 30      | One approval pause you built by hand, redone on a graph library with a Postgres checkpointer, resumed on the same thread | `bun run verify part run-the-agent-on-langgraph` |

## How each step works

1. Read the step's problem. It starts with a real case from the world.
2. Do the challenge in the step's `problem/` folder.
3. Run `bun run verify <step-name>`.
4. For each `FAIL` line, read the `Try next:` line. Fix that one thing, then run the check again.

[SUBMIT.md](SUBMIT.md) says what you hand in for each part, and how it is graded.

## Your employee

Build, Deploy and Operate use the freight audit clerk. It is the only employee with a world pack today, in
`worlds/freight-audit`. A world pack holds the seed data, the SQLite ledger, the people with roles, and the planted traps.

In Design, you may pick any employee below, or bring your own. For example, you can write the hire letter for the grant
screener. The Design checks read your files. They do not use a world. The other nine employees have no world pack yet.

| Employee                      | Business                           | Hired for                                                                    | Must never                                            | Planted trap                                           |
| ----------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------ |
| Freight audit clerk (default) | A freight broker                   | Each carrier invoice paid or disputed per the rate and the proof of delivery | Pay twice, or above the rate without the finance lead | A duplicate invoice under a new number                 |
| Spoiled food claims handler   | A home insurer                     | Each claim under the limit settled per the policy                            | Decline a claim without a claims officer              | A claim on a lapsed policy                             |
| Work order writer             | A rural power co-op                | Each vegetation report turned into a safe work order                         | Send crews to a line not marked de-energised          | A report on a live line                                |
| Referral coordinator          | A family clinic                    | Each referral booked with the right specialist inside the wait limit         | Book without the doctor's order on file               | A patient who opted out                                |
| Damage assessor               | A construction equipment hire firm | Each returned machine assessed and any deposit charge decided                | Charge a deposit without photo evidence               | A photo dated before the rental started                |
| Cover lesson planner          | A primary school                   | A cover lesson ready by the start of school for each absent teacher          | Use material not on the approved list                 | A year group with no approved unit                     |
| Supplier terms negotiator     | A grocery chain                    | Better terms with tail-end suppliers inside the buyer's limits               | Agree terms outside the buyer's limits                | A supplier asks for a longer payment term than allowed |
| Shift hiring coordinator      | A restaurant group                 | Each open shift filled with a screened applicant                             | Offer a job without the manager's sign-off            | An applicant under the minimum age                     |
| Grant screener                | A charity foundation               | Each application screened and scored against the fund's rules                | Award above the board's limit                         | An applicant already funded under another name         |
| Milk pickup planner           | A dairy farm co-op                 | Each farm's tank collected before it is full                                 | Send a driver past their legal driving limit          | A tank alarm with only one rested driver               |

## Case studies

Read these first. Then design your own solution.

- [Case Study 1: Enterprise Agentic HCP System](case-studies/enterprise-agentic-hcp-system.md)
- [Case Study 2: Autonomous AI Teammates](case-studies/autonomous-ai-teammates.md)

## How the repo works

[STANDARD.md](STANDARD.md) lists the rules for every course repo, and the check behind each rule. Model ids and the dated
price table live in one file: [config/models.ts](config/models.ts). The checker library has its own page:
[checks/lib/README.md](checks/lib/README.md).

## Models

Code asks [config/models.ts](config/models.ts) for a role: `fast`, `smart` or `judge`. It never asks for a model by name.

`LLM_PROVIDER` picks who answers. The choices are `replay`, `anthropic`, `openrouter` and `openai`. The default is
`replay`. It uses recorded replies and needs no key.

To use a real provider, copy `.env.example` to `.env` and add the key. Then test every role with one tiny call each.

```bash
bun run models
```

Expect: `Provider: replay`, a `pass` line for `fast`, `smart` and `judge` with its cost, then `Every role answered.` If a model has no price in the table, its cost shows as unknown, never as zero.

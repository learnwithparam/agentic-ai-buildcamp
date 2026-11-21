# Place it on the map

## The problem

KaaS Freight paid one load twice and lost USD 3,140. First decide what the clerk is.

Ask one question: can code list every next step? If yes, build a workflow. If no, the model must decide the next step. Then
code guards the lines the model must not cross.

For example, `INV-2041` is clean, so the clerk pays it. `INV-2028` bills detention, so the clerk must look for a signed
delay. The clerk cannot list every next step in advance. So the clerk is an agent.

Allianz's Project Nemo passes food spoilage claims between seven agents. A person decides the final payout.

```mermaid
flowchart TD
  Q{Can code list every next step?} -->|yes| W[Workflow: code decides]
  Q -->|no| A[Agent: the model decides]
  A -->|work splits across employees| S[Agentic system: models hand work on]
  S --> H[A person makes the last write]
```

## Your challenge

Fill in `map.md` for your employee. It has these sections:

- `## Problem`: who pays, and a cost with a number.
- `## Choice`: the first line is `workflow`, `agent` or `agentic system`.
- `## Why`: the line "Who decides the next step: code" or "Who decides the next step: the model".

| Employee                                    | What to place                                                    |
| ------------------------------------------- | ---------------------------------------------------------------- |
| Freight clerk (KaaS Freight)                | Matching invoices to rate confirmations and proofs of delivery   |
| Spoiled food claims handler (home insurer)  | Claims after a power cut; a lapsed policy needs a claims officer |
| Work order writer (rural power co-op)       | Repair orders; crews only on lines marked de-energised           |
| Referral coordinator (family clinic)        | Specialist bookings that follow a doctor's order                 |
| Grant screener (charity foundation)         | Applications against the board's limit                           |
| Cover lesson planner (primary school)       | Cover lessons from the approved list                             |
| Supplier terms negotiator (grocery chain)   | Supplier terms inside the buyer's limits                         |
| Shift hiring coordinator (restaurant group) | Shift offers after the manager signs off                         |
| Damage assessor (equipment hire firm)       | Deposit charges backed by photos                                 |
| Milk pickup planner (dairy co-op)           | Pickup routes inside each driver's legal limit                   |
| Your own job                                | One task you repeat, and what a mistake in it costs              |

## Done when

- `map.md` has Problem, Choice and Why.
- The Problem names a cost with a number.
- The Choice and the decider agree. Workflow goes with code. Agent or agentic system goes with the model.

```bash
bun run verify place-it-on-the-map
```

Expect: `Done. All 6 rules pass.`

Run it first. The FAIL lines are your to-do list.

The freight sample is in [solution/map.md](../solution/map.md).

## If you get stuck

| What you see                                                         | Fix                                                     |
| -------------------------------------------------------------------- | ------------------------------------------------------- |
| `FAIL the Problem names a cost with a number`                        | Add the money, count or time lost, as a digit.          |
| `FAIL the first line of Choice is workflow, agent or agentic system` | Put only that word on the first line under `## Choice`. |
| `FAIL the Choice and the decider agree`                              | If code picks every next step, the choice is workflow.  |

## Words you will use

- **Workflow**: code picks every next step. The model may fill in a field.
- **Agent**: the model picks the next tool to call.
- **Agentic system**: several agents hand work to each other.
- **Starts by**: what starts a job. It can be a person, an event, a schedule or another agent.

Source: [Allianz, Project Nemo](https://www.allianz.com/en/mediacenter/news/articles/251103-when-the-storm-clears-so-should-the-claim-queue.html), read 2026-11-12.

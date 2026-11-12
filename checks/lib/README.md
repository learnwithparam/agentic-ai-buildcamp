# The checker library

Every behaviour check uses this library. It never imports the learner's code: it starts their employee from its
`employee.toml`, talks to it through [contract version 1](../../reference/CONTRACT.md), and reads the ledger, the
world's logs and the traces. The reply is only a claim.

| File            | What it does                                                                                                                                                                                                                                                                                                         |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `employee.ts`   | Finds `employee.toml` (the folder the check points at, then `EMPLOYEE_DIR`, then `employee/` at the repo root), starts the employee on a free port with `PORT`, `WORLD_URL`, `TRACE_DIR`, `STATE_DIR` and `MODEL_MODE=replay`, waits up to 10 s for `GET /health`, and can `kill` (SIGKILL), `restart` and `stop` it |
| `contract.ts`   | The six routes over HTTP, or the same six as CLI commands, plus `waitJob`                                                                                                                                                                                                                                            |
| `world.ts`      | A fresh in-memory copy of the world on a free port, the planted traps, and `truth`: what the evidence allows for an invoice                                                                                                                                                                                          |
| `traces.ts`     | Reads `employee.trace/v1` files and works out spend from token counts and the dated price table                                                                                                                                                                                                                      |
| `trials.ts`     | `passK`: a behaviour passes only when 3 fresh trials pass (reset ledger, new process, empty state)                                                                                                                                                                                                                   |
| `behaviours.ts` | Every behaviour the course checks, by step name, and `behaviourRule` for a step check                                                                                                                                                                                                                                |

A step check for a behaviour is one rule:

```ts
import { behaviourRule } from "./lib";
export default [
  behaviourRule(
    "pay-one-invoice",
    "the ledger shows the clean invoice paid once at the rate",
    "read the FAIL line above, fix the write, run it again",
  ),
];
```

`bun test` runs every behaviour against `reference/` (each must pass 3 of 3 trials) and against each planted-fault
employee in `tests/faulty/` (each must fail the checks named in its `employee.toml`).

Settings for a slow machine: `CHECK_TRIALS` (default 3), `CHECK_TIMEOUT_MS` (how long a planted timeout waits,
default 250), `CHECK_MODEL_MODE` (default `replay`; `live` lets your employee call its model).

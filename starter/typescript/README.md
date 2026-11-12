# Starter employee: TypeScript

A contract server, a plain job loop, a SQLite job table and the trace writer, in Bun with no packages to install.
Out of the box it passes `answer-the-contract` and `call-the-tools`, and nothing after. Every later step is yours.

| File            | What it does                                                                     |
| --------------- | -------------------------------------------------------------------------------- |
| `employee.toml` | How the checker starts it                                                        |
| `start.ts`      | The six routes of contract version 1                                             |
| `src/agent.ts`  | The job loop: reads the evidence, asks the model for a draft. Paying is the TODO |
| `src/jobs.ts`   | The job table in `STATE_DIR`                                                     |
| `src/tools.ts`  | Calls the world's tools with `X-Tenant`                                          |
| `src/trace.ts`  | Writes `employee.trace/v1` spans                                                 |
| `src/model.ts`  | One model call by role; `LLM_PROVIDER` and `config/models.ts` pick the model     |

Copy it to `employee/` at the repo root and work there. The checker looks for `employee/employee.toml`.

```bash
cp -r starter/typescript employee
bun run verify answer-the-contract
```

Expect: `Done.` and the rules for `answer-the-contract` all `PASS`.

With no `ANTHROPIC_API_KEY` the loop skips the model call and still reads the evidence. A Python learner can
use `starter/python/` instead; the checks are the same.

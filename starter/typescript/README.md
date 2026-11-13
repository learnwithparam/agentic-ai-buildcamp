# Starter employee: TypeScript

This starter gives you four pieces, written for Bun with no packages to install. It has a contract server, a plain
job loop, a SQLite job table and a trace writer. As it comes, it passes `answer-the-contract` and `call-the-tools`.
It passes nothing after that. You write every later step.

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

If `ANTHROPIC_API_KEY` is not set, the loop skips the model call. It still reads the evidence. For example, on
`INV-2041` it still reads the invoice, the rate confirmation and the proof of delivery.

Do you prefer Python? Use `starter/python/` instead. The checks are the same.

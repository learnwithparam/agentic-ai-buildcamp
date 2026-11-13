# Starter employee: Python

This starter gives you four pieces, run with `uv`. It has a FastAPI contract server, a plain job loop, a SQLite
job table and a trace writer. Every package has one exact version, set with `==` in `pyproject.toml`. As it comes,
it passes `answer-the-contract` and `call-the-tools`. It passes nothing after that.

| File                 | What it does                                                                     |
| -------------------- | -------------------------------------------------------------------------------- |
| `employee.toml`      | How the checker starts it: `uv run --quiet python -m employee`                   |
| `employee/server.py` | The six routes of contract version 1                                             |
| `employee/agent.py`  | The job loop: reads the evidence, asks the model for a draft. Paying is the TODO |
| `employee/jobs.py`   | The job table in `STATE_DIR`                                                     |
| `employee/tools.py`  | Calls the world's tools with `X-Tenant`                                          |
| `employee/trace.py`  | Writes `employee.trace/v1` spans                                                 |
| `employee/model.py`  | One model call by role; `LLM_PROVIDER` and `config/models.ts` pick the model     |

The checker runs on Bun, so install Bun once, even on the Python path. `bun run verify meet-the-world --setup`
tells you how. Then copy the starter to `employee/` at the repo root and work there.

```bash
cp -r starter/python employee
cd employee && uv sync && cd ..
bun run verify answer-the-contract
```

Expect: `uv sync` installs the pinned packages, then the rules for `answer-the-contract` all `PASS`.

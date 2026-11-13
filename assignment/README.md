# Assignment: pay once after a crash, with LangGraph

This is optional in the live session and expected as homework. Work on it beside the class, in the language of your choice.

## The task

Rebuild "pay once after a crash" with LangGraph and a Postgres checkpointer. Keep your own approval rule from the build part.

For example, an invoice for USD 7,850 is over the limit. Your graph pauses at `pay`. A new process answers "approved" on the same `thread_id`, and the ledger gets one row.

## Start

```bash
docker compose -f assignment/compose.yml up -d --wait
```

Expect: `Container assignment-db-1  Healthy`.

Edit `graph.ts` or `graph.py`. Both nodes are stubs. The step page has the install commands.

## Done when

The check reads these lines. Each is one `pass` or `fail` in `result.json`.

- The LangGraph package in the lockfile is the pinned version.
- A run above the limit stops at an interrupt and writes a checkpoint row.
- After the script kills and restarts the process, the run resumes on the same `thread_id`.
- The ledger has exactly one payment row for that run.
- A run below the limit finishes with no interrupt.

```bash
bun assignment/check.ts
```

Expect: `Every line passes.` once your graph is built, and the tool versions in `assignment/result.json`.

Stop and remove the database when you are done.

```bash
docker compose -f assignment/compose.yml down -v
```

Expect: `Removed` for the container, the volume and the network.

## Rubric

A person reads three lines. No points.

- The approval rule is yours from the build part.
- The pay node is safe to run twice.
- `CHOICE.md` says in five sentences or fewer when you would pick Google ADK instead.

## Submit

Push a branch named `assignment` and submit its URL. The grader reruns `bun assignment/check.ts`.

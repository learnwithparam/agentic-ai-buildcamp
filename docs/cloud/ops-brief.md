You are building one part of learnwithparam/agentic-ai-buildcamp in a cloud session. A separate orchestrator session on the owner's laptop will measure your work with real model calls, fix it, and merge it. You build the code and its deterministic tests; you do not produce the measured numbers.

## Setup (do this first, in this order)

1. `git checkout -b cloud/ops origin/main`
2. Postgres 16 with pgvector: `sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-16-pgvector` (if apt has no postgresql-16, use the PGDG apt repo). Start a cluster on port 5432, create role `medinfo` and database `medinfo` owned by it, and `CREATE EXTENSION vector`. Write a `.env` from `.env.example` with DATABASE_URL pointing at it. Never print `.env`.
3. `npm ci`. Leave `core.hooksPath` as it is. The pre-push release gate skips pushes to `cloud/*` branches, because the model gateway exists only on the owner's laptop; the orchestrator runs the gate when it pushes your work. Never use `--no-verify`.
4. OpenFGA: try the release binary from github.com/openfga/openfga/releases (linux amd64) with `--datastore-engine memory`. If it cannot run, say so and skip the tests that need it.
5. Docker, Keycloak, Langfuse and the model gateway are not available. Tests that need them are skipped, and your final report names each one.

## Rules of this repo

- Read `AGENTS.md` and `docs/measures.md` first. Read the lesson page for your part under `docs/learner/`.
- Every model call goes through `src/server/gateway.ts` (`modelClient()`). Never import a provider SDK directly.
- `data/hcp/` is a pinned copy of learnwithparam/dataset. Never edit it. If your part needs new data, write the exact file content you need into `docs/cloud/ops-dataset.md` on your branch; the orchestrator lands it in the dataset repo.
- Do not edit `docs/measures.md` numbers or `docs/runs/*.json`. Write the measuring script; the orchestrator runs it.
- A measure script writes `docs/runs/<part>.json` with the same shape as `docs/runs/search.json` (read `scripts/search-eval.ts` for the pattern) and prints its rows. It must run offline with a fake model (`--fake`) so its own test proves the arithmetic, and with the real model by default.
- Every new test is shown failing first: break the code, run the test, see red, restore.
- Never write a comment or doc line that claims something the code does not do. Plain English, no em dashes. Run `npm run check:pages` if you change docs.
- Do not touch `.github/workflows/` (the token cannot push it). Do not touch files owned by another part (listed below).
- No session URL and no `Claude-Session` trailer in any commit. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not widen scope. What you leave out goes in the report.

## Done

- `npm run typecheck` passes and every test you can run passes (`npm run check` if the environment allows it; otherwise list what you ran).
- Push `cloud/ops` to origin. Do not open a PR and do not merge.
- Write `docs/cloud/ops-report.md` on the branch, committed: what you built, the files, each test and whether you saw it fail first, the tests you could not run and why, the exact command the orchestrator should run to measure, and anything you left out.

## Files other parts own (do not edit)

- search: `src/server/rag/**`, `scripts/search-eval.ts`
- citations: `src/server/citations.ts`, `src/server/citations.*`, `scripts/citations-*.ts`
- ae: `src/server/tiers.ts`, `src/server/safety/**`, migration `012_*`
- evals: `scripts/run-dataset.ts`, `scripts/release-gate.ts`, `scripts/judge-calibrate.ts`, `scripts/eval-*.ts`
- faults: `src/server/faults/**`, `scripts/faults-*.ts`
- phi: `src/server/phi.ts`, `src/server/phi.*`, `scripts/phi-*.ts`
- ops: `src/server/app.ts` middleware, `src/server/labels.ts` (TODAY only), `src/server/ops/**`, migration `013_*`
Shared files (`src/server/medinfo-agent.ts`, `src/server/tools.ts`, `src/server/routes.ts`): keep your edits there small and self-contained so a rebase merges cleanly.

## Your part

PART = ops. Production basics (new `src/server/ops/`, `src/server/app.ts` middleware, `src/server/labels.ts` TODAY).

Bar: 21 CFR 11.10(e) for the audit trail (append-only, time-stamped, earlier values kept); per-user limits; measured latency and cost.

Build:
- `review_events`: an append-only table (who, item, action, before, after, at), migration `013_review_events.sql`, with a trigger that refuses UPDATE and DELETE. Every review decision writes one row. The current review row stays as the read model.
- `TODAY` becomes the real date, with an env override (`MEDINFO_TODAY`) used by tests and the dataset runner, so the eval cases stay stable. Find every use and keep the eval runner pinned.
- A per-user rate limit and turn cap on the chat API (Postgres-backed so it holds across restarts, a 429 with a plain message and no operator detail).
- Metrics per turn: latency, cost (from the gateway's usage), and structured output parse failures, as Langfuse scores on the trace.
- `scripts/ops-eval.ts` (npm script `ops:measure`): runs the demo questions and writes `docs/runs/ops.json` with `p95_latency_seconds`, `cost_per_question_usd`, `parse_failure_rate`.
- Tests: UPDATE and DELETE on review_events are refused by Postgres, a decision writes one event with before and after, the override pins TODAY, the limit returns 429 after the cap, the percentile arithmetic with `--fake`.

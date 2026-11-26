You are building one part of learnwithparam/agentic-ai-buildcamp in a cloud session. A separate orchestrator session on the owner's laptop will measure your work with real model calls, fix it, and merge it. You build the code and its deterministic tests; you do not produce the measured numbers.

## Setup (do this first, in this order)

1. `git fetch origin search-hybrid && git checkout -b cloud/phi origin/search-hybrid`
2. Postgres 16 with pgvector: `sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-16-pgvector` (if apt has no postgresql-16, use the PGDG apt repo). Start a cluster on port 5432, create role `medinfo` and database `medinfo` owned by it, and `CREATE EXTENSION vector`. Write a `.env` from `.env.example` with DATABASE_URL pointing at it. Never print `.env`.
3. `npm ci`, then `git config --unset core.hooksPath`. The pre-push release gate calls a model gateway that exists only on the owner's laptop; the orchestrator runs that gate when it pushes your work. Do not use `--no-verify` anywhere else.
4. OpenFGA: try the release binary from github.com/openfga/openfga/releases (linux amd64) with `--datastore-engine memory`. If it cannot run, say so and skip the tests that need it.
5. Docker, Keycloak, Langfuse and the model gateway are not available. Tests that need them are skipped, and your final report names each one.

## Rules of this repo

- Read `AGENTS.md` and `docs/measures.md` first. Read the lesson page for your part under `docs/learner/`.
- Every model call goes through `src/server/gateway.ts` (`modelClient()`). Never import a provider SDK directly.
- `data/hcp/` is a pinned copy of learnwithparam/dataset. Never edit it. If your part needs new data, write the exact file content you need into `docs/cloud/phi-dataset.md` on your branch; the orchestrator lands it in the dataset repo.
- Do not edit `docs/measures.md` numbers or `docs/runs/*.json`. Write the measuring script; the orchestrator runs it.
- A measure script writes `docs/runs/<part>.json` with the same shape as `docs/runs/search.json` (read `scripts/search-eval.ts` for the pattern) and prints its rows. It must run offline with a fake model (`--fake`) so its own test proves the arithmetic, and with the real model by default.
- Every new test is shown failing first: break the code, run the test, see red, restore.
- Never write a comment or doc line that claims something the code does not do. Plain English, no em dashes. Run `npm run check:pages` if you change docs.
- Do not touch `.github/workflows/` (the token cannot push it). Do not touch files owned by another part (listed below).
- No session URL and no `Claude-Session` trailer in any commit. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not widen scope. What you leave out goes in the report.

## Done

- `npm run typecheck` passes and every test you can run passes (`npm run check` if the environment allows it; otherwise list what you ran).
- Push `cloud/phi` to origin. Do not open a PR and do not merge.
- Write `docs/cloud/phi-report.md` on the branch, committed: what you built, the files, each test and whether you saw it fail first, the tests you could not run and why, the exact command the orchestrator should run to measure, and anything you left out.

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

PART = phi. Rebuild PHI scrubbing (lesson 13, `src/server/phi.ts`). Today 4 regexes; names, dates of birth and addresses pass through.

Bar: Redacta: pseudonymise before the model sees it, recall 0.99 and near zero false positives on 300 notes.

Build:
- A pseudonymiser: names, dates of birth, addresses, record numbers, phones, emails, social security numbers replaced by stable placeholders per conversation (`[PATIENT_1]`, `[DOB_1]`), with the map kept server side only so the doctor's reply can be re-identified on the way out, and never in a trace or checkpoint.
- Rules first (shapes, dates near "born" or "DOB", titles plus capitalised words), then one json_schema model call through the gateway for the names and addresses the rules miss, returning spans that code checks are substrings of the text. Measure rules alone and rules plus model.
- An output leak check: the final text sent to the model, the trace payload and the checkpoint contain no original identifier; a test proves it against the Postgres checkpointer.
- `scripts/phi-eval.ts` (npm script `phi:measure`): runs `data/hcp/safety/phi-notes.jsonl` (100 notes with gold spans; read it) and writes `docs/runs/phi.json` with `recall` (by span, per type), `false_positives_per_note`, and `output_leaks`.
- Tests: each identifier type, the clinical numbers that must survive (doses, lab values, "eGFR 32", dates of events that are not dates of birth), stable placeholders across turns, the measure arithmetic with `--fake`.

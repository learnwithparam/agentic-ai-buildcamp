You are building one part of learnwithparam/agentic-ai-buildcamp in a cloud session. A separate orchestrator session on the owner's laptop will measure your work with real model calls, fix it, and merge it. You build the code and its deterministic tests; you do not produce the measured numbers.

## Setup (do this first, in this order)

1. `git fetch origin search-hybrid && git checkout -b cloud/ae origin/search-hybrid`
2. Postgres 16 with pgvector: `sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-16-pgvector` (if apt has no postgresql-16, use the PGDG apt repo). Start a cluster on port 5432, create role `medinfo` and database `medinfo` owned by it, and `CREATE EXTENSION vector`. Write a `.env` from `.env.example` with DATABASE_URL pointing at it. Never print `.env`.
3. `npm ci`, then `git config --unset core.hooksPath`. The pre-push release gate calls a model gateway that exists only on the owner's laptop; the orchestrator runs that gate when it pushes your work. Do not use `--no-verify` anywhere else.
4. OpenFGA: try the release binary from github.com/openfga/openfga/releases (linux amd64) with `--datastore-engine memory`. If it cannot run, say so and skip the tests that need it.
5. Docker, Keycloak, Langfuse and the model gateway are not available. Tests that need them are skipped, and your final report names each one.

## Rules of this repo

- Read `AGENTS.md` and `docs/measures.md` first. Read the lesson page for your part under `docs/learner/`.
- Every model call goes through `src/server/gateway.ts` (`modelClient()`). Never import a provider SDK directly.
- `data/hcp/` is a pinned copy of learnwithparam/dataset. Never edit it. If your part needs new data, write the exact file content you need into `docs/cloud/ae-dataset.md` on your branch; the orchestrator lands it in the dataset repo.
- Do not edit `docs/measures.md` numbers or `docs/runs/*.json`. Write the measuring script; the orchestrator runs it.
- A measure script writes `docs/runs/<part>.json` with the same shape as `docs/runs/search.json` (read `scripts/search-eval.ts` for the pattern) and prints its rows. It must run offline with a fake model (`--fake`) so its own test proves the arithmetic, and with the real model by default.
- Every new test is shown failing first: break the code, run the test, see red, restore.
- Never write a comment or doc line that claims something the code does not do. Plain English, no em dashes. Run `npm run check:pages` if you change docs.
- Do not touch `.github/workflows/` (the token cannot push it). Do not touch files owned by another part (listed below).
- No session URL and no `Claude-Session` trailer in any commit. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not widen scope. What you leave out goes in the report.

## Done

- `npm run typecheck` passes and every test you can run passes (`npm run check` if the environment allows it; otherwise list what you ran).
- Push `cloud/ae` to origin. Do not open a PR and do not merge.
- Write `docs/cloud/ae-report.md` on the branch, committed: what you built, the files, each test and whether you saw it fail first, the tests you could not run and why, the exact command the orchestrator should run to measure, and anything you left out.

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

PART = ae. Rebuild adverse event handling (lesson 13, `src/server/tiers.ts`, plus a new `src/server/safety/`). Today one model call decides, with no floor, and an overdue 24 hour clock triggers nothing.

Bar: ICH E2D(R1) section 2.2, the four minimum criteria (identifiable reporter, identifiable patient, suspect product, adverse event); MedDRA LLT to PT coding; E2B(R3) case shape.

Build:
- Two layers: the existing router, plus a second pass on every message the router sends to `answer`: one json_schema call that asks only "does this describe something that happened to a patient after a medicine, including indirect wording and special situations (pregnancy exposure, overdose, medication error, lack of effect)?". Either layer saying yes routes to safety. Write it so the second pass can be measured alone.
- Extraction of the four criteria and MedDRA coding against `data/hcp/safety/meddra-synthetic.json` (read it: LLT, PT, SOC levels, fictional codes). The model proposes terms; code maps them to codes from the dictionary and refuses a code that is not in it.
- An E2B(R3)-shaped XML draft (`src/server/safety/e2b.ts`), built in code from the extraction; a person submits it. Validate the element names you use against the ICH E2B(R3) ICSR element list (C.1, D, E.i, G.k sections); keep it a draft, never call it a submission.
- A clock job: when an open safety item passes `due_at`, it is escalated (status, an `escalated_at`, and a second notification row). Migration `012_safety_escalation.sql`. Add it to the existing review/inbox code without changing other review types.
- `scripts/ae-eval.ts` (npm script `ae:measure`): runs `data/hcp/safety/ae-reports.jsonl` (79 rows: is_adverse_event, indirect, special_situation, criteria, meddra; read it) and writes `docs/runs/ae.json` with `recall`, `precision`, `criteria_accuracy`, `coding_accuracy` (PT match), and `overdue_escalated` from a real database test of the clock.
- Tests: the dictionary refuses unknown codes, the clock escalates an overdue item against Postgres, the XML draft has the required elements, either layer routes to safety, the measure arithmetic with `--fake`.

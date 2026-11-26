You are building one part of learnwithparam/agentic-ai-buildcamp in a cloud session. A separate orchestrator session on the owner's laptop will measure your work with real model calls, fix it, and merge it. You build the code and its deterministic tests; you do not produce the measured numbers.

## Setup (do this first, in this order)

1. `git fetch origin search-hybrid && git checkout -b cloud/evals origin/search-hybrid`
2. Postgres 16 with pgvector: `sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-16-pgvector` (if apt has no postgresql-16, use the PGDG apt repo). Start a cluster on port 5432, create role `medinfo` and database `medinfo` owned by it, and `CREATE EXTENSION vector`. Write a `.env` from `.env.example` with DATABASE_URL pointing at it. Never print `.env`.
3. `npm ci`, then `git config --unset core.hooksPath`. The pre-push release gate calls a model gateway that exists only on the owner's laptop; the orchestrator runs that gate when it pushes your work. Do not use `--no-verify` anywhere else.
4. OpenFGA: try the release binary from github.com/openfga/openfga/releases (linux amd64) with `--datastore-engine memory`. If it cannot run, say so and skip the tests that need it.
5. Docker, Keycloak, Langfuse and the model gateway are not available. Tests that need them are skipped, and your final report names each one.

## Rules of this repo

- Read `AGENTS.md` and `docs/measures.md` first. Read the lesson page for your part under `docs/learner/`.
- Every model call goes through `src/server/gateway.ts` (`modelClient()`). Never import a provider SDK directly.
- `data/hcp/` is a pinned copy of learnwithparam/dataset. Never edit it. If your part needs new data, write the exact file content you need into `docs/cloud/evals-dataset.md` on your branch; the orchestrator lands it in the dataset repo.
- Do not edit `docs/measures.md` numbers or `docs/runs/*.json`. Write the measuring script; the orchestrator runs it.
- A measure script writes `docs/runs/<part>.json` with the same shape as `docs/runs/search.json` (read `scripts/search-eval.ts` for the pattern) and prints its rows. It must run offline with a fake model (`--fake`) so its own test proves the arithmetic, and with the real model by default.
- Every new test is shown failing first: break the code, run the test, see red, restore.
- Never write a comment or doc line that claims something the code does not do. Plain English, no em dashes. Run `npm run check:pages` if you change docs.
- Do not touch `.github/workflows/` (the token cannot push it). Do not touch files owned by another part (listed below).
- No session URL and no `Claude-Session` trailer in any commit. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not widen scope. What you leave out goes in the report.

## Done

- `npm run typecheck` passes and every test you can run passes (`npm run check` if the environment allows it; otherwise list what you ran).
- Push `cloud/evals` to origin. Do not open a PR and do not merge.
- Write `docs/cloud/evals-report.md` on the branch, committed: what you built, the files, each test and whether you saw it fail first, the tests you could not run and why, the exact command the orchestrator should run to measure, and anything you left out.

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

PART = evals. Rebuild the eval suite (lessons 06 to 09 and 18: `scripts/run-dataset.ts`, `scripts/release-gate.ts`, `scripts/judge-calibrate.ts`). Today 11 `llm-rubric` asserts in `data/hcp/evals/*.yaml` are silently dropped, the judge runs on 9 cases, and the release gate has 8 cases.

Bar: Groundwork (a frozen floor plus a sabotage test that must go red) and Groundhog (pass^5).

Build:
- Every `llm-rubric` assert runs through the calibrated judge, or the runner fails loudly naming it. Nothing is dropped silently; a test walks every yaml file and fails on any assert type the runner does not handle.
- The judge calibration set raised toward 60 items. You cannot label: write a script that builds the candidate items from the dataset and a labelling file format with two labeller columns, and the agreement arithmetic (Cohen's kappa and raw agreement). List in your report exactly what the orchestrator must label.
- The release gate covers every slice: at least one case per slice in `metadata.slice`, chosen by a rule in code, not a hand list. A test proves every slice has a release case.
- A sabotage run: `--sabotage` runs the gate with a broken prompt variant (drop the citation rule and the defer rule) and must exit non-zero. A test with a fake model proves the gate goes red on it.
- pass^5: `scripts/eval-passk.ts` (npm script `evals:measure`) runs the demo set k=5 times and writes `docs/runs/evals.json` with `pass_rate` per slice, `pass_hat_5`, `sabotage_caught` and `judge_agreement`.
- Tests: no dropped assert, slice coverage, sabotage red with a fake model, pass^k arithmetic.

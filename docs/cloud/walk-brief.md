You are building one part of learnwithparam/agentic-ai-buildcamp in a cloud session. A separate orchestrator session on the owner's laptop will measure your work with real model calls, fix it, and merge it. You build the code and its deterministic tests; you do not produce the measured numbers.

## Setup (do this first, in this order)

1. `git checkout -b cloud/PART origin/main`
2. Postgres 16 with pgvector: `sudo apt-get update && sudo apt-get install -y postgresql-16 postgresql-16-pgvector` (if apt has no postgresql-16, use the PGDG apt repo). Start a cluster on port 5432, create role `medinfo` and database `medinfo` owned by it, and `CREATE EXTENSION vector`. Write a `.env` from `.env.example` with DATABASE_URL pointing at it. Never print `.env`.
3. `npm ci`, then `git config --unset core.hooksPath`. The pre-push release gate calls a model gateway that exists only on the owner's laptop; the orchestrator runs that gate when it pushes your work. Do not use `--no-verify` anywhere else.
4. OpenFGA: try the release binary from github.com/openfga/openfga/releases (linux amd64) with `--datastore-engine memory`. If it cannot run, say so and skip the tests that need it.
5. Docker, Keycloak, Langfuse and the model gateway are not available. Tests that need them are skipped, and your final report names each one.

## Rules of this repo

- Read `AGENTS.md` and `docs/measures.md` first. Read the lesson page for your part under `docs/learner/`.
- Every model call goes through `src/server/gateway.ts` (`modelClient()`). Never import a provider SDK directly.
- `data/hcp/` is a pinned copy of learnwithparam/dataset. Never edit it. If your part needs new data, write the exact file content you need into `docs/cloud/PART-dataset.md` on your branch; the orchestrator lands it in the dataset repo.
- Do not edit `docs/measures.md` numbers or `docs/runs/*.json`. Write the measuring script; the orchestrator runs it.
- A measure script writes `docs/runs/<part>.json` with the same shape as `docs/runs/search.json` (read `scripts/search-eval.ts` for the pattern) and prints its rows. It must run offline with a fake model (`--fake`) so its own test proves the arithmetic, and with the real model by default.
- Every new test is shown failing first: break the code, run the test, see red, restore.
- Never write a comment or doc line that claims something the code does not do. Plain English, no em dashes. Run `npm run check:pages` if you change docs.
- Do not touch `.github/workflows/` (the token cannot push it). Do not touch files owned by another part (listed below).
- No session URL and no `Claude-Session` trailer in any commit. Commits end with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`.
- Do not widen scope. What you leave out goes in the report.

## Done

- `npm run typecheck` passes and every test you can run passes (`npm run check` if the environment allows it; otherwise list what you ran).
- Push `cloud/PART` to origin. Do not open a PR and do not merge.
- Write `docs/cloud/PART-report.md` on the branch, committed: what you built, the files, each test and whether you saw it fail first, the tests you could not run and why, the exact command the orchestrator should run to measure, and anything you left out.

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

## Your part: the checkpoint walk (scripts/checkpoints-walk.ts)

Today no checkpoint tag is proven live: `sync-checkpoints.sh --verify` only runs unit tests. Build the script that proves each tag the way a learner meets it. You build and test it here; the orchestrator runs it on the laptop, one tag at a time, because memory allows one stack.

For one tag (`npm run walk -- checkpoint/NN-name`, or `--all` for every tag in order), the script:

1. Makes a git worktree for the tag under the OS temp dir, links the caller's env file into it by path (never reads or prints it), runs `npm ci` and `npm run setup`.
2. Starts the app (`npm run dev` or the tag's own start script, read from its package.json) and waits for its health URL.
3. Reads the lesson page for the tag (`docs/learner/NN-*.md` on that tag) and its `walk` block: a fenced block ```walk with one JSON object per line, `{ "user": "<demo user>", "ask": "<question>", "route": "<tier>", "sections": ["doc 2.2"], "cites": true }`. Asks each question through the real `/api` with the real model, reusing the client in `scripts/demo-turns.ts` (sign-in, cookie, stream parse); import it, do not copy it. Asserts route, sections found and that citations are present.
4. Runs each `bash` block on the page that is preceded by `<!-- run -->`, and compares the lines the page quotes in the block right after it marked `<!-- output -->` with the real output (each quoted line must appear; numbers must match exactly).
5. Captures `docs/flows/<tag>/*.json` with the code behind `npm run flows:capture` (import it).
6. Stops the app and the stack it started, removes the worktree in a `finally`, also on Ctrl-C.
7. Writes one row per tag to `docs/checkpoint-walk.md`: tag, tag commit, date, questions passed of asked, run blocks passed of run, trace ids, and the first failure in plain words.

Also:

- A check in `scripts/check-repo.ts`: fail when a tag listed by `scripts/sync-checkpoints.sh` has no row in `docs/checkpoint-walk.md`, or its row names an older commit than the tag. While the file does not exist yet the check reports "not walked yet" as a problem only under `--release` (follow how measures.md pending rows are handled).
- `scripts/checkpoints-walk.test.ts`, offline: parsing the walk block (bad JSON line fails with its line number), the run/output comparison (a quoted line that is missing fails, a changed number fails), the row writer, and the freshness check (missing row, stale commit). Each test shown failing first.
- Add the `walk` npm script, and one line in `docs/learner/18-release-gate.md` that shows `npm run walk -- --all` before a release.
- Do not add walk blocks to the lesson pages; the orchestrator writes those per lesson. Add one to `docs/learner/20-rag.md` only, as the example, with two questions taken from `data/hcp/gold/retrieval.jsonl`.
- No Playwright screenshots in this part; leave a clear `TODO`-free note in your report that screenshots come next.

Files you own: `scripts/checkpoints-walk.ts`, `scripts/checkpoints-walk.test.ts`, `docs/checkpoint-walk.md` (do not create it with fake rows; only the script writes it). Small edits: `scripts/check-repo.ts`, `package.json` scripts, the two lesson pages above.

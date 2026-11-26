# Checkpoint walk: report

## What I built

`npm run walk -- checkpoint/NN-name` (or `--all`, in the order of `scripts/sync-checkpoints.sh`) proves a tag the way a learner meets it. For each tag it:

1. makes a git worktree under the OS temp dir, links the env file into it by path (`WALK_ENV_FILE`, default `.env` in the repo; the file is never read or printed), runs `npm ci` and `npm run setup`;
2. starts the stack only when `infra:up` exists and no compose service is running, then the app (`npm run dev`, else `npm start`), and waits for `/api/health`;
3. reads `docs/learner/NN-*.md` on that tag, asks each `walk` block question through the real `/api` with the client in `scripts/demo-turns.ts`, and checks route, sections found and citation;
4. runs each bash block marked `<!-- run -->` and compares the block marked `<!-- output -->` right after it: every quoted line must appear, a changed number is reported as changed numbers;
5. captures `docs/flows/<tag>/*.json` with `captureFlows` from `scripts/flows-capture.ts`;
6. stops the app and the stack it started and removes the worktree in a `finally`, also on Ctrl-C or SIGTERM;
7. writes one row per tag to `docs/checkpoint-walk.md`: tag, commit, date, questions passed of asked, run blocks passed of run, trace ids, first failure.

The exit code is 1 when any tag has a failure.

## Files

- `scripts/checkpoints-walk.ts` (new), `scripts/checkpoints-walk.test.ts` (new).
- `scripts/demo-turns.ts`: now exports `ask`, `newThread` and `Seen`, and runs its conversations only when run directly. Behavior of `npm run demo:check` and `demo:open` is the same.
- `scripts/flows-capture.ts`: now exports `captureFlows(checkpoint, only, into)` and runs only when run directly. `npm run flows:capture` is the same.
- `scripts/check-repo.ts`: new walk check (below).
- `package.json`: `walk` script.
- `docs/learner/18-release-gate.md`: one paragraph and the `npm run walk -- --all` block.
- `docs/learner/20-rag.md`: the example `walk` block, two questions from `data/hcp/gold/retrieval.jsonl` (r-001, section 2.2; r-002, section 2.6), both asked as `ana`.
- `docs/checkpoint-walk.md` is not created: only the script writes it.

## The check in `check-repo`

Fails when a tag listed in `sync-checkpoints.sh` has no row, or its row names a different commit than the tag tip (the row keeps 12 characters). With no `docs/checkpoint-walk.md`, "not walked yet" is a problem only with `--release`, as with `docs/measures.md`. Two choices to know:

- A tag the clone does not have is skipped, so a clone without tags passes.
- On a checked-out checkpoint tag the check is skipped. The sync's `--verify` runs `npm run check` on each tag after it moves the tag, so a fresh tag commit would otherwise always look stale. The check runs from `main`.

Not wired into `sync-checkpoints.sh --push`. It runs `measures.ts --release`; adding `check-repo --release` there is the orchestrator's call.

## Tests (`scripts/checkpoints-walk.test.ts`, 16, offline, no model call)

I wrote them, saw them pass, then broke the code and saw red (restored each time):

| Test | Broken how | Red |
| --- | --- | --- |
| bad JSON line number; missing route line number | line offset changed | yes (2 tests) |
| changed number | number branch removed | yes |
| missing quoted line | comparison always passes | yes |
| row names an older commit | staleness test removed | yes |
| tag with no row | missing-row test removed | yes |
| not walked yet only on release | release flag ignored | yes |
| row writer replaces the tag's row | replace removed | yes |
| only `<!-- run -->` blocks run | marker ignored | yes |

Other tests (walk block, row format, order, tag list, question judgement, demo user) were not each broken separately.

## What I ran

- `npm run typecheck`: passes.
- `npx tsx --test 'scripts/**/*.test.ts'`: 107 of 108 pass. The one failure is `fga-model.test.ts`, which needs Docker for OpenFGA.
- `npm run check:pages`: passes except the mermaid step (`mmdc` not installed); no diagram changed.
- Full `npm run check`: the `src/**` tests that need Postgres (`TEST_DATABASE_URL`) fail here: a2a, auth, sweep, bi, content and others. I did not set up Postgres or OpenFGA, because nothing in this part needs them. These are environment failures, not from this change.
- `npx tsx scripts/check-repo.ts` also reports `scripts/.diag/ae-diag.ts` (tracked on `origin/main`, not mine, names `src/server/safety/*` which does not exist). Present before my change.

## Could not run

- The walk itself (worktree, `npm ci`, app start, real asks, flows capture): needs Keycloak, Langfuse and the model gateway. The code path in `walkTag` is not run end to end. The orchestrator's first walk will be its first run.
- Setup note: the brief says to run `git config --unset core.hooksPath`; the sandbox denied that, so I left it. `npm ci` set the hooks path to `.githooks`.

## Measure command

```bash
npm run walk -- checkpoint/20-rag      # one tag; needs the stack, Langfuse and the gateway up, and a built tag
npm run walk -- --all                  # every tag in order, one at a time
npx tsx scripts/check-repo.ts --release
```

## Left out, and things to know

- Playwright screenshots: they come next.
- `walk` blocks for the lessons other than 20: the orchestrator writes them. A tag with no block records 0 of 0 questions and no failure.
- Tags 00 to 10 have no sign-in, so `newThread` cannot sign in on them. Their lessons need no walk block until someone writes a different client.
- Trace ids in the row come from the flows capture (3 per tag), not from the asked questions: `demo-turns` does not return a trace id.
- `captureFlows` always runs the three fixed examples, which need sign-in and `search_labels`-era trace spans; on earlier tags it will fail and the row's first failure says so.
- `parseCitations` is imported from `src/server/citations.ts` on `main`, so the citation check uses `main`'s rules, not the tag's.

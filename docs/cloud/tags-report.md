# Tags report: one start tag per lesson

Branch `cloud/tags`, built from `origin/main` at `fe9d811`. No tag was pushed. The tags below exist only in this clone. `checkpoint/08-wrap-up` is untouched (see "Where I did not follow the brief").

## What I built

**`scripts/lesson-files.json`** gives every tracked file on main its lesson. A number is the lesson that adds the file (0 is the starting repo, on every tag). A list is that lesson, then each later lesson that changes the file, for example `[11, 13, 14, 17, 20]`. `"main"` keeps a file off every tag (`.github/`, the sync script and its test, the scoreboard alignment, `docs/cloud/`). `lessonEnd` names the commit on main where each lesson ended. That commit is where an older version of a file is read from. I made the first draft from `git log` (the lesson that first added each file) and the existing tags, then fixed it by hand from the lesson pages and the typecheck on every tag.

**`scripts/lesson-tags.ts`** turns the manifest into a plan. It has no imports besides `node:` modules:

- `tagFiles`, `holds`, `versionOn` and `sourceOf` say which files tag N holds and where each copy comes from: main (newest version), a commit from `lessonEnd` (an older version), or the tag's own copy (the untraced app of lessons 0 to 2, which no commit holds).
- `tagScripts` and `tagPackage` cut `package.json` down to the scripts whose files the tag holds. A `&&` step goes alone, `npm run` calls to a dropped script go too, and `bin` goes with `build:cli`.
- `tagLock` and `tagCoverage` list only the dataset files and eval cases the tag holds.
- `youAdd` and `expand` read a lesson page's "You add" list.

**`scripts/sync-checkpoints.sh`** no longer has `milestone_files()` or the 13 file lists. For each tag it asks `lesson-tags.ts plan N`, builds the tree aside (main, an older commit, or the tag's own copy), copies the shared `checkpoint-sync` regions from main into every older version, derives `package.json`, the dataset lock and `docs/coverage.md`, then replaces the tag's files. It still keeps `.github/`, runs the scoreboard alignment, and `--verify` and `--push` work as before. It now needs full history (`git fetch --unshallow`); the workflow already has `fetch-depth: 0`.

**`scripts/check-repo.ts`** loads `scoreboard.ts` and `measures.ts` only when they exist, because lesson 6 adds the first and lesson 23 the second. **`scripts/scoreboard.test.ts`** skips a `--cases` id whose agent file the tag does not hold yet.

**Tests, `scripts/sync-checkpoints.test.ts`** (offline, main only):

1. every tracked file has an owner, and the manifest names no file that is gone;
2. a file's lessons rise, and each is a lesson that exists;
3. on every tag, each npm script names only files the tag holds, and calls only scripts the tag has;
4. on every tag, a file imports only files the tag holds. It reads each file as that tag holds it (main's copy, or `git show` of the older commit);
5. each lesson page from 10 on lists its "You add" files, they are not on its own tag, and they are on the next tag at that lesson's version;
6. no tag holds an eval file whose cases are a later chapter, and each tag's coverage table names only cases the tag holds;
7. each agent's eval file comes with the lesson its cases belong to;
8. a tag's dataset lock lists only files the tag holds.

**Pages 10 to 23 are builds.** Each says: check out the tag (the start of the lesson); "This tag is where lesson N starts"; "You add" (or "You change") plus the file list; the commands to start services moved to after the files are in place; and a closing "Check your build" step with `npm run check` and `git diff --stat <next tag>`. I did page 23 too, not only 10 to 22.

**`scripts/lesson-shape.ts`** now fails a page from lesson 10 on when: it has no "You add" list; a named path is no file on main, or is a file the lesson does not add or change; the tag already holds a file the page says you add; or the build has no `npm run check` or no `git diff --stat <next tag>` line. `scripts/page-checks.test.ts` has a case for each.

**AGENTS.md and README.md** describe the new rules (Rule 1, "Syncing checkpoint tags", "How the checkpoints work").

**Also:** I deleted `scripts/.diag/ae-diag.ts`. It came in with #108, nothing reads it, and it made `npx tsx scripts/check-repo.ts` fail on main.

## Where I did not follow the brief

- **Eval cases are filtered by file, not by case.** Each agent's file (`fact-check`, `outreach`, `a2a`, `events`, `autonomy`, `insights`) holds only that lesson's cases and comes with that lesson. I could not filter `medinfo.yaml` per case: it is the dataset lesson's own file, its cases name the chapter that makes them pass (`chapter: "11"` means "red until lesson 11"), and lessons 06 to 08 teach that those cases are red on purpose ("yours runs all 38"). So all 38 cases are on every tag from lesson 6 on. The test says this in a comment and checks the other files strictly.
- **The lessons 0 to 2 files have no commit.** The untraced `index.ts`, `medinfo-agent.ts` and `tools.ts` (and the traced-without-prompt versions on tag 03) exist only in the old tags, so for those versions the sync keeps the tag's own copy. If those tags were deleted, those few versions could not be rebuilt from main. Every later version is read from a commit.
- **Some files hold lesson 20's final version from tag 21 on, which pulls in later lessons' changes.** Lesson 20's search was rewritten in #106, after lessons 21 to 23 were done, and it uses code from the lesson 23 fixes (#84, #86, #87). No commit holds "lesson 22's app with lesson 20's new search", so `src/server/rag/*`, `labels.ts`, `tools.ts`, `permissions.ts`, `users.ts`, `scripts/identity-setup.ts` and `trace-identity.test.ts` take main's version from tag 21 on (the manifest lists their last change as lesson 20). The effect: tags 21 and 22 already have the `analyst` role in `users.ts` and `permissions.ts` (lesson 22 adds the analyst), and tags 21 to 23 have the country search and the five label tools (lesson 23 fixes). Page 23 now says `src/server/rag/search.ts` is already in the tag instead of listing it as a change. I found this by typecheck failures on tags 21 to 23, one file at a time; the list is what the typecheck needed, not a hand-picked set.
- **`scripts/scoreboard.test.ts` has no version for lessons 18 and later**, because the older versions fail on the pages: every tag holds all lesson pages, and the test checks every `--cases` list against the tag's dataset. Main's version skips the ids of an agent whose eval file the tag does not hold yet.
- **All of `docs/` is lesson 0** (every page, image and flow file is on every tag, as AGENTS.md always said), except `docs/scoreboard.md` (lesson 6, one version per lesson), `docs/measures.md` and `scripts/measures.ts` (lesson 23, where #104 added them) and `docs/runs/search.json` (lesson 20). `docs/coverage.md` is lesson 0 but derived per tag. The page tools (`lesson-shape`, `glossary`, `mermaid`, `plain-english`, `page-checks.test`), `check-repo.ts` and `.node-version` are lesson 0 too. `scripts/no-fake-model.test.ts` is lesson 21, where #72 added the rule; older tests build stand-in clients.
- **`.github/` is off every tag now.** Tag 23 still carried an old copy, and its workflows failed `check-repo` there. The sync used to keep a tag's own `.github/`; it now removes it, which is what AGENTS.md already said.
- **The brief's item 5 had nothing to remove.** `grep -rn "08-wrap-up"` finds no mention in `README.md`, the sync script, `AGENTS.md` or the pages on `origin/main`. The tag `checkpoint/08-wrap-up` exists in this clone, untouched, and not in the sync's `TAGS`. Deleting it is the orchestrator's job.
- **I did not run `sync-checkpoints.sh --verify`.** It stops at the first tag whose `npm run check` fails, and every tag past lesson 11 has tests that need Keycloak, OpenFGA or Postgres (the same ones that fail on main). I ran the sync without `--verify`, then ran typecheck, `npm run check`'s test command and `check-repo` on each tag in a separate worktree and read every failing test's message (below).
- **`package.json` dependencies and `package-lock.json` are the same on every tag.** Only scripts and `bin` are cut down. An unused package on an early tag does no harm, and a smaller lock would need `npm install` to rewrite it.
- **Pages 00 to 09 are not changed.** The brief asked for 10 to 22; I did 10 to 23.

## Tests I saw fail first

Each new check was broken on purpose, run red, restored, and run green (`npx tsx --test scripts/sync-checkpoints.test.ts scripts/page-checks.test.ts`; baseline 21 pass, 0 fail):

| Break | Red | Green |
| --- | --- | --- |
| `git add scripts/zz-new.ts`, a tracked file with no owner | `not ok 12 - every tracked file on main has an owner lesson`, naming `scripts/zz-new.ts` | file removed: 21 pass |
| the script filter made to keep every script (`filesPresent` always true) | `not ok 14 - on every tag, each npm script names only files the tag holds`: `tag 0: the script "setup" runs scripts/setup.ts, which the tag does not hold`; also `not ok 16` | filter restored: 21 pass |
| `src/server/gateway.ts` owner 10 to 9 (the page's file is on its own tag) | `not ok 17 - a lesson page lists the files it adds...`: `docs/learner/10-ai-gateway.md: src/server/gateway.ts is already on tag 10`; `lesson-shape.ts`: `tag 10 already holds src/server/gateway.ts, so the page cannot ask you to add it` | manifest restored |
| `src/server/gateway.ts` owner 10 to 11 (the page's file is missing from the next tag) | `not ok 17`: `src/server/gateway.ts is added by a later lesson`; `not ok 15` lists every file on tag 11 that imports it | manifest restored |
| `src/server/graph.ts` loses lesson 21 from its list (page 21 says you add it) | `not ok 15` (tag 17 to 20 import `citations.ts`, which the tag lacks) and `lesson-shape.ts`: `tag 21 already holds src/server/graph.ts` | manifest restored |
| `data/hcp/evals/a2a.yaml` owner 15 to 6 (eval cases on earlier tags) | `not ok 18 - a tag holds no eval case from a later lesson`: `tag 7 holds data/hcp/evals/a2a.yaml, whose cases are chapter 15` (tags 7 to 14); `not ok 17` for page 15 | manifest restored |
| `src/server/tiers.ts` owner 13 to 14 | `not ok 15 - on every tag, a file imports only files the tag holds`: `tag 14: src/server/graph.ts imports src/server/tiers.ts, which the tag lacks` | manifest restored |
| (the page shape checks) `page-checks.test.ts` feeds `lesson-shape.ts` a page with no "You add" list, a file the tag already holds, a made-up file, no `npm run check` and no `git diff --stat`, and expects each message | I did not break `lesson-shape.ts` to see this one red; the two real-page cases above (`tag 10 already holds`, `tag 21 already holds`) are the red runs of the same code | 21 pass |

The existing tests also failed on the first tag builds, and each failure fixed a real mistake in the manifest or in a shared tool:

- `scripts/check-repo.ts` on tags 0 to 12 (`scripts/measures` and `scripts/hcp-cases` do not exist; `docs/coverage.md` and `.node-version` missing; `lesson-files.json` and `lesson-tags.ts` "in no use"; `npm run infra:up` shown by no doc, because pages were on the wrong tags). Fixed with the dynamic loads, lesson 0 for docs and page tools, and `infra` in the script filter.
- the typecheck on tags 21 to 23 (`inForceDocuments`, `companyDocuments` and `analyst` missing), described above.
- `scripts/scoreboard.test.ts` (`16-event-driven-agents.md names EVENT-01, which is not in the dataset`) on tags 16 to 20.
- `scripts/no-fake-model.test.ts` (`a cast to the OpenAI client` in `a2a.test.ts` and `content.test.ts`) on tags 15 to 21.
- `trace-identity.test.ts` (`no spans were recorded`) on tags 21 to 23.
- `check-repo` on tag 23, from its old `.github/` workflows.

## What each tag holds

Counts are files in the tag. "Added" is the new files since the tag before, so each row is the lesson before it; "Changed" is the files whose version moved. Tags 00, 01 and 02 are identical (the untraced app). Tags 07, 08 and 09 are identical, because lesson 8 adds no file.

| Tag | Files | Added since the tag before | Changed |
| --- | --- | --- | --- |
| `checkpoint/00-setup` | 225 | the starting repo (untraced app, docs, labels) | |
| `checkpoint/01-base-app` | 225 | 0: none | 0 |
| `checkpoint/02-tracing` | 225 | 0: none | 0 |
| `checkpoint/03-prompt-management` | 225 | 0: none | 3 |
| `checkpoint/04-monitoring` | 228 | 3: `scripts/prompt-variants.test.ts`, `scripts/prompt-variants.ts`, `scripts/publish-prompt.ts` | 2 |
| `checkpoint/05-dataset` | 235 | 7: `scripts/error-analysis-replay.ts`, `scripts/error-analysis-traffic.ts`, `scripts/error-analysis.test.ts`, `scripts/record-error-analysis.ts`, `scripts/seed-error-analysis-annotations.ts`, `scripts/seed-error-analysis-traces.ts`, 1 data/doc files | 1 |
| `checkpoint/06-experiments` | 238 | 3: `scripts/hcp-cases.ts`, `scripts/seed-dataset.ts`, 1 data/doc files | 3 |
| `checkpoint/07-evaluation` | 242 | 4: `scripts/run-dataset.ts`, `scripts/scoreboard.test.ts`, `scripts/scoreboard.ts`, 1 data/doc files | 1 |
| `checkpoint/08-midpoint` | 242 | 0: none | 0 |
| `checkpoint/09-advanced-evals` | 242 | 0: none | 0 |
| `checkpoint/10-ai-gateway` | 248 | 6: `scripts/judge-calibrate.ts`, `scripts/judge/faithfulness.test.ts`, `scripts/judge/faithfulness.ts`, `scripts/seed-faithfulness-calibration.ts`, 2 data/doc files | 7 |
| `checkpoint/11-sign-in` | 251 | 3: `scripts/langfuse-gateway-keys.ts`, `src/server/gateway.test.ts`, `src/server/gateway.ts` | 8 |
| `checkpoint/12-mcp-sandbox` | 273 | 22: `infra/docker-compose.yml`, `infra/openfga/model.fga`, `infra/openfga/model.fga.yaml`, `infra/postgres/init/01-databases.sh`, `scripts/fga-model.test.ts`, `scripts/fga-model.ts`, `scripts/identity-setup.ts`, `scripts/identity-smoke.ts`, `src/client/chat/` (2), `src/server/app.ts`, `src/server/auth.test.ts`, `src/server/auth.ts`, `src/server/db.ts`, `src/server/labels.test.ts`, `src/server/migrations/001_sessions.sql`, `src/server/permissions.test.ts`, `src/server/permissions.ts`, `src/server/sessions.test.ts`, `src/server/sessions.ts`, `src/server/trace-identity.test.ts`, `src/server/users.ts` | 17 |
| `checkpoint/13-durable-review` | 287 | 14: `.claude/skills/hcp-labels/SKILL.md`, `.mcp.json`, `scripts/langfuse-code-eval.ts`, `src/executor/.dockerignore`, `src/executor/Dockerfile`, `src/executor/executor.test.ts`, `src/executor/package-lock.json`, `src/executor/package.json`, `src/executor/planted.ts`, `src/executor/sandbox.ts`, `src/executor/server.ts`, `src/executor/worker.ts`, `src/server/mcp.test.ts`, `src/server/mcp.ts` | 7 |
| `checkpoint/14-content-agents` | 301 | 14: `src/client/inbox/` (2), `src/server/durable.test.ts`, `src/server/inbox.test.ts`, `src/server/migrations/002_reviews.sql`, `src/server/phi.ts`, `src/server/reviews.ts`, `src/server/test-desk.ts`, `src/server/tiers.test.ts`, `src/server/tiers.ts`, 4 data/doc files | 28 |
| `checkpoint/15-a2a` | 320 | 19: `src/client/content/` (2), `src/server/content/` (4), `src/server/migrations/003_content_reviews.sql`, `src/server/migrations/004_review_requests.sql`, 11 data/doc files | 25 |
| `checkpoint/16-events` | 330 | 10: `scripts/a2a-runner.ts`, `src/client/content/`, `src/server/a2a/` (6), `src/server/migrations/005_a2a_tasks.sql`, 1 data/doc files | 18 |
| `checkpoint/17-autonomy` | 343 | 13: `scripts/events-runner.ts`, `scripts/events-send.ts`, `src/client/content/`, `src/server/events/` (6), `src/server/migrations/006_events.sql`, 3 data/doc files | 24 |
| `checkpoint/18-release-gate` | 351 | 8: `scripts/sweep-runner.ts`, `src/client/content/`, `src/server/auto/` (4), `src/server/migrations/007_sweep.sql`, 1 data/doc files | 20 |
| `checkpoint/19-cli` | 355 | 4: `.githooks/pre-push`, `scripts/experiment.ts`, `scripts/release-gate.test.ts`, `scripts/release-gate.ts` | 4 |
| `checkpoint/20-rag` | 363 | 8: `src/cli/api.ts`, `src/cli/cli.test.ts`, `src/cli/config.ts`, `src/cli/index.tsx`, `src/cli/session.ts`, `src/cli/turn.ts`, `src/cli/ui.tsx`, `src/shared/sse.ts` | 7 |
| `checkpoint/21-citations` | 404 | 41: `scripts/rag-ingest.ts`, `scripts/rag-setup.ts`, `scripts/search-eval.test.ts`, `scripts/search-eval.ts`, `src/server/migrations/008_label_chunks.sql`, `src/server/migrations/011_label_search.sql`, `src/server/rag/` (8), 27 data/doc files | 15 |
| `checkpoint/22-insights` | 421 | 17: `scripts/citations-audit.test.ts`, `scripts/citations-audit.ts`, `scripts/citations-replay.test.ts`, `scripts/citations-replay.ts`, `scripts/live-spans.ts`, `scripts/no-fake-model.test.ts`, `scripts/no-model-call.ts`, `src/server/a2a/` (2), `src/server/auto/` (2), `src/server/citations.fixtures.json`, `src/server/citations.test.ts`, `src/server/citations.ts`, `src/server/content/`, `src/server/rag/`, 1 data/doc files | 16 |
| `checkpoint/23-full-run` | 436 | 15: `infra/postgres/init/02-bi-roles.sh`, `scripts/bi-setup.ts`, `scripts/doctor.test.ts`, `scripts/doctor.ts`, `scripts/setup.test.ts`, `scripts/setup.ts`, `src/client/insights/`, `src/server/bi/` (4), `src/server/migrations/009_sales.sql`, 3 data/doc files | 21 |

## What I ran, and what I could not run

Passing on `cloud/tags` (main):

- `npm run check`: 183 pass, 19 fail. The 19 are the same tests that fail on `origin/main` before my change (172 pass, 19 fail): `permissions.test.ts`, `sessions.test.ts`, `auth.test.ts`, `mcp.test.ts`, `durable.test.ts`, `inbox.test.ts`, `content.test.ts`, `a2a.test.ts`, `events.test.ts`, `sweep.test.ts`, `bi.test.ts`, `rag.test.ts` and the OpenFGA model test. They need Keycloak, OpenFGA or Postgres (`TEST_DATABASE_URL`). My 11 new tests pass.
- `npx tsx scripts/check-repo.ts` passes.
- `npm run check:pages` passes (it needs `mmdc`; I installed `@mermaid-js/mermaid-cli` and pointed `PUPPETEER_EXECUTABLE_PATH` at the preinstalled Chromium).

On each of the 24 tags (a worktree sharing main's `node_modules`): `tsc --noEmit` passes; `scripts/check-repo.ts` passes; every failing test in the `npm run check` test command is one of the service tests above, and I read the message of each (`TEST_DATABASE_URL is not set`, or the OpenFGA model test). Tags 00 to 11 have no failing test at all.

Not run:

- the 19 service tests, on main and on every tag, because there is no Keycloak, OpenFGA, Postgres or Docker here;
- `npm run check:live` (needs the real model and a gateway key);
- `sync-checkpoints.sh --verify --push`, and the GitHub Action. The tags exist only in this clone;
- `npm ci` per tag. All tags share main's `package-lock.json`, so I reused one `node_modules`;
- a learner walk-through of pages 10 to 23 (checkout, add the parts, run the check, diff with the next tag). The tests prove the files are where the page says; I did not build a lesson by hand.

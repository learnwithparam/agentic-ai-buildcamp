# Ops report

Branch `cloud/ops`, from `origin/main` 18eeb63. Part: production basics.

## What I built

- **Audit trail.** `review_events` (migration `013_review_events.sql`): id, item_id, actor, action, before (jsonb), after (jsonb), at. A row trigger refuses UPDATE and DELETE, and a statement trigger refuses TRUNCATE. `ReviewStore.decide` and `reopen` now run one SQL statement each (`src/server/ops/review-events.ts`) that changes `review_items` and inserts the event together, so a decision with no event cannot happen. A reopen writes a `reopened` row by `system`; the earlier decision row stays. `review_items` is still the read model.
- **TODAY.** `src/server/ops/today.ts` `resolveToday()`: the real UTC date, or `MEDINFO_TODAY` (must be a real `YYYY-MM-DD`, else it throws). `labels.ts` `TODAY` uses it.
- **Limits.** `src/server/ops/limits.ts` `ChatLimiter` (table `chat_turns`, migration `013_chat_limits.sql`): 10 turns a minute and 200 a day per user, counted in Postgres under a per-user advisory lock. `chatLimit` middleware answers 429 `{ error: LIMIT_MESSAGE }` with `Retry-After`; no counts or limits in the body. `createApp(auth, desk, limiter?)` mounts it on the two chat stream routes (`/api/threads/:id/runs/stream`, `/api/insights/threads/:id/runs/stream`) after sign-in. `index.ts` passes `new ChatLimiter(pool)`.
- **Per-turn metrics.** `src/server/ops/meter.ts`: `meteredFetch` wraps the gateway's fetch (`gateway.ts`, three lines). While a turn runs inside `measureTurn`, it reads each model answer (JSON or event stream) for `usage.cost` and checks that structured output parses. `medinfo-agent.ts` `runTurn` wraps the graph in `measureTurn` and `scoreTurn` (`ops/metrics.ts`) sends Langfuse NUMERIC scores `latency_seconds`, `cost_usd`, `parse_failures` on the turn's trace, in the background. A turn with a call that reported no cost gets no `cost_usd` score.
- **Measure script.** `scripts/ops-eval.ts`, `npm run ops:measure`: runs the 31 demo questions in `scripts/open-questions.ts`, one at a time, through `runMedinfoTurn` as the `eval-runner` service, and writes `docs/runs/ops.json` with `ops.p95_latency_seconds`, `ops.cost_per_question_usd`, `ops.parse_failure_rate` plus `commit`, `at`, `questions`, `structured_calls`, `model_calls`, `fake`. `--fake` feeds 20 fixed turn records to the same summary and writes `docs/runs/ops.fake.json` (or `--out`), never `ops.json`.
- **Pinning.** `package.json` scripts `check`, `check:live`, `dataset:run`, `release:gate`, `judge:calibrate`, `citations:audit`, `citations:replay`, `ops:measure` and `.githooks/pre-push` set `MEDINFO_TODAY=${MEDINFO_TODAY:-2026-11-23}`. I could not edit `scripts/run-dataset.ts` or `scripts/release-gate.ts` (owned by evals), so the pin is in the commands that start them.
- `AGENTS.md` has a short "Production basics" note (it also satisfies the `check-repo` rule that every npm script is shown in a doc). `.env.example` has a commented `MEDINFO_TODAY` line.

## Files

New: `src/server/migrations/013_review_events.sql`, `013_chat_limits.sql`, `src/server/ops/{today,review-events,limits,meter,metrics}.ts`, `src/server/ops/ops.test.ts`, `src/server/ops/ops-db.test.ts`, `scripts/ops-eval.ts`, `scripts/ops-eval.test.ts`, this report.
Edited: `src/server/{reviews,labels,gateway,app,index,medinfo-agent}.ts`, `package.json`, `.githooks/pre-push`, `.env.example`, `AGENTS.md`.

## Tests, and whether I saw each fail first

I broke the code, ran the test, saw red, and restored it. All pass now.

| Test | Broken how | Red |
| --- | --- | --- |
| decision writes one event with before and after (`ops-db` 1, 2) | the event insert never matches a row | yes |
| reopen keeps the decision and adds a system row (`ops-db` 3) | reopen as a bare UPDATE | yes |
| UPDATE, DELETE, TRUNCATE refused (`ops-db` 4) | dropped both triggers in the database | yes |
| limiter allows the cap, refuses the next, per user (`ops-db` 5), and the concurrent test (7) | `>=` changed to `>` | yes (5, 7, 8) |
| daily cap (`ops-db` 6) | `>=` changed to `>` on the daily check | yes |
| chat API 429 (`ops-db` 8) | limiter not mounted in `app.ts` | yes |
| override pins TODAY (`ops` 2, 3) | override ignored | yes |
| package scripts and hook pin the day (`ops` 4) | removed the pin from `dataset:run` | yes |
| scores sent per turn (`ops` 9) | score guard disabled | yes |
| structure detection, stream joining (`ops` 5, 7) | not run red | **no** |
| meter reads cost and parse failures (`ops` 6, 8) | JSON check always true | yes |
| p95 nearest rank (`ops-eval` 1) | `ceil` changed to `floor` | yes |
| summary and `--fake` file (`ops-eval` 2, 4) | mean divided by twice the turns | yes |
| missing cost stops the run (`ops-eval` 3) | not run red | **no** |

## What I could not run

- `npm run check` ran: 258 pass, 22 fail, and the 22 are environment, not this change: OpenFGA tests (`permissions`, `inbox`, `mcp`, `content`, `a2a`; no OpenFGA binary was run and the model transform needs Docker), the insights tests (`bi:setup` needs Docker, so I made empty `bi_pharma_a`/`bi_pharma_b` roles by hand just to let migration 009 run), the sweep test (Langfuse 503), and one rag test (`hnsw.iterative_scan` needs pgvector 0.8; apt installed an older one). I did not run `main` for a baseline comparison. `npm run typecheck`, `tsx scripts/check-repo.ts`, and `check:pages` (except the mermaid step, which needs `mmdc`) pass.
- Not run: Keycloak, Docker, Langfuse, the model gateway. I did not try the OpenFGA release binary.
- `npm run ops:measure` without `--fake` is **not run**. It is typechecked only. It needs the gateway, `rag:ingest` done, and OpenFGA.

## Measure command for the orchestrator

```
npm run ops:measure
```

It needs a gateway that returns `usage.cost` in each answer (the streamed agent call asks for it with `include_usage`; I did not check the non-streamed calls). If any call has no cost the script stops with an error and writes nothing, instead of a cost that is too low. Then fill the three `ops.*` rows in `docs/measures.md` from `docs/runs/ops.json`.

## Left out, and things to know

- Parse failures count JSON that does not parse, or a forced tool call that returned none. A schema (zod) failure on valid JSON is not counted, because that check lives in `tiers.ts` and `rag/grade.ts`, which other parts own.
- The BI insights agent's turns are not metered (only `medinfo-agent.ts`).
- Only decisions and reopens write events. Creating an item does not.
- A database owner can still drop the trigger. The app's login should not own the table.
- No lesson page. `docs/learner/` has none for this part and I did not add one.
- A `MEDINFO_TODAY` line in `.env` beats a script's value (`load-env.ts` uses `override: true`). `.env.example` says so.
- Per-turn `cost_usd` and `latency_seconds` are scored for every turn including review resumes.
- The limits (10 a minute, 200 a day) are my choice; the brief gave none.
- Run any script straight with `tsx` (not `npm run`) and it uses the real date unless `MEDINFO_TODAY` is set.

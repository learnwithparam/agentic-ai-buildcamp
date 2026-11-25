# Agent notes for this repo

This file tells agents and maintainers how to change the Langfuse workshop repository safely.

## How to handle changes

### Rule 1: Propagate changes across checkpoints

`main` alone is not enough. Learners check out `checkpoint/*` tags during the workshop. If you change something those checkouts need, update every affected checkpoint tag before considering the work done.

Canonical checkpoint tags:

- `checkpoint/00-setup`
- `checkpoint/01-base-app`
- `checkpoint/02-tracing`
- `checkpoint/03-prompt-management`
- `checkpoint/04-monitoring`
- `checkpoint/05-dataset`
- `checkpoint/06-experiments`
- `checkpoint/07-evaluation`
- `checkpoint/08-midpoint`
- `checkpoint/09-advanced-evals`
- `checkpoint/10-ai-gateway`
- `checkpoint/11-sign-in`
- `checkpoint/12-mcp-sandbox`
- `checkpoint/13-durable-review`
- `checkpoint/14-content-agents`
- `checkpoint/15-a2a`
- `checkpoint/16-events`
- `checkpoint/17-autonomy`
- `checkpoint/18-release-gate`
- `checkpoint/19-cli`
- `checkpoint/20-rag`
- `checkpoint/21-citations`

What to propagate:

| Change type | Propagate to checkpoints? | How |
| --- | --- | --- |
| Anything outside the milestone files (`docs/`, `README.md`, `AGENTS.md`, `package.json`, `scripts/`, `data/`, client code, shared server code) | Yes: every tag | Automatic: the `Sync checkpoint tags` action copies `main` onto every tag |
| Shared content inside a milestone file (for example the `SYSTEM_PROMPT`) | Yes: every tag | Keep it between `// checkpoint-sync:begin <name>` and `// checkpoint-sync:end <name>`; the sync copies that region |
| Milestone-only app code (for example tracing wrappers that only exist from `02-tracing` onward) | Only tags that already contain that code path | Lives in the milestone files, which the sync leaves alone; patch those tags by hand and do not invent the feature on earlier milestones |

Do not stop at a PR to `main` when checkpoints still carry the old shared state. After the merge, check that the action run succeeded. Document force-moved tag tips in the PR when you update tags by hand.

### Other change rules

- Keep `main` as the complete reference app plus current docs.
- Keep `checkpoint/00-setup` equivalent to `checkpoint/01-base-app` for environment validation.
- Keep one milestone tag for each workshop step.
- Make every later step runnable through explicit fallbacks (local prompt fallback, shared scripts, stable trace shape, and so on).
- Prefer small, workshop-safe diffs. Do not rebuild overview docs that learners do not need.

## Documentation scope

- Keep the root `README.md` focused on learners: workshop scope, how to run it, the lesson map, and minimal checkpoint usage.
- Facilitator notes live in the private teach repo (`teach/courses/agentic-ai-buildcamp`), never in this repo.
- Learner lessons open with `## Why …` (why the practice matters), then `## Goal` (what this lab achieves), then `## Starting point` (the checkout), then the numbered steps.
- Do not recreate overview files such as `docs/README.md`, `docs/learner/README.md`, or `docs/checkpoints.md`. Put learner-facing overview content in the root README or the learner lessons; put maintainer-only checkpoint strategy here.

## Checkpoint strategy

The workshop needs two things at once:

1. A clean linear story that matches the Langfuse AI engineering loop.
2. The ability to jump ahead when a live workshop runs out of time.

Canonical progression:

- `00-setup`: setup, keys, local Langfuse from `langfuse/docker-compose.yml`, OpenRouter, Langfuse CLI, Langfuse skill, and workshop framing on the same untraced app state as `01-base-app`.
- `01-base-app`: working HCP Medical Information Agent on the official OpenAI SDK, with one fixed desk context, two local tools, and no Langfuse tracing yet.
- `02-tracing`: learners add Langfuse tracing on top of the base app with OpenTelemetry setup, `observeOpenAI(new OpenAI())`, `observe(...)` wrappers around app/tool functions, and optional `propagateAttributes(...)` for user/session metadata.
- `03-prompt-management`: learners replace the code-only prompt path with a Langfuse-managed prompt plus local fallback.
- `04-monitoring`: starts from the traced app. The overview introduces dashboards, error analysis, and production signals. Error analysis replays 20 recorded CardioNex turns with `npm run langfuse:seed:error-analysis` (13 pass, 7 fail: asking for facts the question already gave, answering where it should refuse, and missing the 2027 label), then an `error analysis` annotation queue with `open coding` (Text) and `pass or fail` (Categorical), which `npm run langfuse:seed:error-analysis:annotations` can fill for learners short on time. Learners cluster the notes, add a `failure category` Categorical score, and build the frequency widget. The page ends with the `error-analysis` prompt variant, and `scripts/prompt-variants.test.ts` checks the page shows it word for word. Capturing signals is the evaluator setup on those message-array observations.
- `05-dataset` ("Build eval datasets"): decides what to evaluate (correct answers and reply/defer/follow-up behavior), then seeds 28 cases from the pinned dataset copy in `data/hcp/`. Each item carries `slice`, `chapter`, `riskTier`, `split` and `showcase` in `metadata`, and the text checks in `expectedOutput.checks`.
- `06-experiments`: runs the app against the Langfuse dataset with `runExperiment` and three callback evaluators: `behavior_match` (Decisions API label plus exact match against `expectedBehavior`), `label_checks` (the dataset's text checks and reason codes) and an LLM-judge `correctness` score that is not part of the pass. Tags 00 to 08 keep that runner as a milestone file; from 09 on, `correctness` is gone. `--chapter 06` appends the baseline row to the learner's git-ignored `my-scoreboard.md` and prints the reason for each failing case. `--reference` writes to `docs/scoreboard.md` instead: use it only for the rows the lessons quote.
- `07-evaluation`: publishes the prompt from the end of `04-monitoring` error analysis (`WORKSHOP_PROMPT_VARIANT=error-analysis`), reruns the same dataset with `--chapter 07`, and compares it with the 06 run side by side.
- `08-midpoint`: recaps the mental model and points to next steps.
- `09-advanced-evals`: labels 21 answers (eleven of the agent's own, ten edited copies) in a `faithfulness calibration` annotation queue, runs the hosted faithfulness evaluator on them by batch evaluation, and measures agreement with `npm run judge:calibrate` (Cohen's kappa, bar 0.6). `data/calibration/faithfulness.json` holds the reference labels and verdicts; `scripts/judge/faithfulness.test.ts` fails below the bar or when the rubric changed since. The judge joins the pass only for the multi-hop, footnote and review slices.
- `10-ai-gateway`: turns on the Langfuse AI gateway (`npm run langfuse:gateway-keys`), connects OpenRouter, and gives `medinfo-app` and `eval-runner` their own service keys with one model and a $1 daily budget each. `src/server/gateway.ts` is the only file that creates a model client; `src/server/gateway.test.ts` walks the tracked sources to keep it so, and proves the input check blocks GUARDRAIL-01 and no other case, with no model call. The behavior decision cannot go through the gateway (`404 no_route`), so it runs inside a traced `behavior-decision` generation.
- `11-sign-in`: `npm run identity:setup` starts `infra/docker-compose.yml` (Postgres, Keycloak, OpenFGA), generates every secret without printing it, and seeds four doctors. `src/server/auth.ts` signs them in on Keycloak (code flow with PKCE, tokens kept in Postgres, an HttpOnly cookie in the browser), and `identityOf` is the one place that reads the company and country, from the verified token. `search_labels` scores only the documents OpenFGA says the doctor may read (`infra/openfga/model.fga`). Traces carry the user id, company and country, never the name or email (`src/server/trace-identity.test.ts`).
- `12-mcp-sandbox`: `src/server/mcp.ts` serves two read-only MCP tools at `/api/mcp` that take only a Keycloak Bearer token (the public `medinfo-mcp` client with PKCE, from `identity:setup`) and reuse lesson 11's OpenFGA filter; `.mcp.json` points Claude Code at it and `.claude/skills/hcp-labels/SKILL.md` is the lookup procedure. `npm run langfuse:code-eval` moves Langfuse code evaluators from `insecure-local` to `src/executor`, a QuickJS executor on an internal-only network (signed jobs, 2 s, 64 MB inside a 96 MB WebAssembly memory). `src/executor/executor.test.ts` and `src/server/mcp.test.ts` hold the proofs; no dataset run, no scoreboard row.
- `13-durable-review`: a router call (`src/server/tiers.ts`, one forced `route` tool call) sorts each message into answer, review, safety or stop before the agent runs; code then does the tier's job: the agent answers, a draft is stamped `REVIEW_REQUIRED` and waits at `interrupt()` for a medical reviewer, an adverse event gets fixed text and a 24 hour item for the safety reviewer, an off-label use gets fixed `OFF_LABEL_REFUSAL`. `src/server/phi.ts` scrubs identifiers before the model, trace or checkpoint sees them. Threads live in Postgres (`PostgresSaver`, schema `langgraph` in the app database); `src/server/reviews.ts` and migration 002 hold the inbox, OpenFGA decides who may decide (`draft` and `adverse_event` types), and each decision is a `review_decision` score on the trace with the reviewer's id. `/inbox` is the reviewer page. The prompt variant `tiered` drops the two rules code now keeps. The dataset run adds a `risk_tier` score on the `routing` slice.
- `14-content-agents`: two more agents on the same base, in `src/server/content/`. The fact-checker (`fact-check.ts`, graph read, match, suggest, write) gives each sentence a verdict in code: `APPROVED` only for an approved claim word for word for the email's country, else `NOT_APPROVED_IN_COUNTRY` or `UNAPPROVED_CLAIM`; the model only suggests a replacement claim. The outreach planner (`outreach.ts`, graph read, propose, decide) lets the model propose one `propose_step` call; code holds a campaign already sent (`HOLD_OUTREACH`), no email to an opt-out, a rep for samples, and builds emails only from approved claims. Both use `modelClient()`, the signed-in user, OpenFGA (`hcp` type, `sales_rep` role, `can_check_against`) and the lesson 13 inbox: a flagged email waits for a medical reviewer, a step for another sales rep (two per company). An item id is a hash of its content (`contentKey`), so the same email raises one item. `/editor` and `/outreach` are staff pages; doctors get 403. The dataset loads `fact-check.yaml` and `outreach.yaml`; each case's `metadata.agent` picks the agent.
- `15-a2a`: both lesson 14 agents behind A2A servers (`@a2a-js/sdk`, `src/server/a2a/`). Each card is public at `/api/a2a/<agent>/.well-known/agent-card.json`, served as `AgentCard.toJSON` (the spec JSON form), with Keycloak as its OpenID Connect scheme. Work takes only a Bearer token, refuses another site's `Origin` and any request tenant, and joins the caller's `traceparent`. `executors.ts` maps results to `COMPLETED`, `INPUT_REQUIRED` (one revision with the approved wording, else a reviewer) or `REJECTED`; tasks live in Postgres (`005_a2a_tasks.sql`, the SDK's `DatabaseTaskStore` table), and `TaskReviews.settle` completes or rejects a task when its inbox item is decided. `handoff.ts` picks a skill from the cards, drafts from the approved claims first, and always sends an email it drafted to a medical reviewer (`REVIEW_REQUIRED`). The A2A `contextId` is the Langfuse session id. `/handoffs` is a staff page. The dataset loads `a2a.yaml` and runs it through `scripts/a2a-runner.ts` (real servers, run-signed tokens, in-memory tasks, no inbox).
- `16-events`: the agents start from signed events (`src/server/events/`). `POST /events/:tenant` checks a Standard Webhooks signature (`standardwebhooks`) with that company's `EVENT_SECRET_<TENANT>` (written by `identity:setup`), then the zod schema, that `webhook-id` equals `event_id`, and that the body's tenant is the sender; it answers 202 before any model runs. `PostgresEventStore` inserts with `ON CONFLICT ... deliveries + 1` and queues a pg-boss job (schema `pgboss`, queue `hcp-event`, dead letter `hcp-event-failed`) only on the first insert, in the same transaction. Handlers run the desk, fact-checker or planner as the company's event worker on a thread named after the event, so a second run reads that thread instead of asking again. `labels.ts` `statusOn(section, today)` works out which label is in force on a day; a graph turn carries `today`. A handled email keeps only its scrubbed text. `/events` is for `REVIEWER_ROLES` and never returns the payload. The dataset loads `events.yaml` and runs it through `scripts/events-runner.ts` (a real webhook, run-made secrets, an in-memory store and inline queue).
- `17-autonomy`: a nightly sweep (`src/server/auto/`) that works with nobody watching inside three limits code enforces. Scope: it runs as `sweepWorker` (role `sweep-agent`, which no Keycloak token carries; OpenFGA `sweep_agent` may view doctors and check claims and decides nothing), and hands each piece to the desk or the outreach planner, so every draft and step waits in the inbox. Budget: before every step `langfuseSpend` asks the Langfuse metrics API for today's `totalCost` of observations whose user id starts with `sweep-<tenant>-`, and an unreadable spend stops the sweep. Off switch: the `agent_controls` row (migration 007) is read before every step, so a pause stops a run at its next step; any reviewer or rep may pause, only a sales rep or medical reviewer may resume or run. pg-boss schedules `hcp-sweep` at `0 2 * * *` UTC, one job per company; `sweep_runs` is the run log with each trace id. `/sweep` is the staff page. The dataset loads `autonomy.yaml` and runs it through `scripts/sweep-runner.ts` (the case fixes the limits and the spend so far).
- `18-release-gate`: the scoreboard becomes a gate (`scripts/release-gate.ts`). It runs the 8 `RELEASE_CASES` through the experiment runner in `scripts/experiment.ts` (shared with `run-dataset.ts`) with the run evaluator `release_pass_rate`, and raises Langfuse's `RegressionError` unless every case ran and passed, so a case the SDK skipped on a provider error is red. `--label staging --promote` resolves the label to one version, pins the agent to it (`usePromptVersion`; a pinned prompt never falls back to `SYSTEM_PROMPT`) and moves `production` onto that version only when green. `.githooks/pre-push` (turned on by the `prepare` script) runs it on the production prompt when a push changes a `GATED_PATHS` file; tags, deletes, docs and the web client skip it. Unpinned, the app reads `LANGFUSE_PROMPT_LABEL`.
- `19-cli`: `medinfo`, a terminal client (`src/cli/`, Ink and commander) on the same API, sign-in and permissions as the web app. `medinfo login` reads `GET /.well-known/oauth-protected-resource/api` (RFC 9728, `src/server/auth.ts`, public) to find Keycloak, then signs in through the public `medinfo-cli` client (PKCE S256, redirect `http://127.0.0.1:33419/callback`, made by `identity:setup`) with a one-shot listener that refuses a wrong `state`. Tokens live in the system keychain (`@napi-rs/keyring`), never a file; a token with under 30 s left is refreshed, `invalid_grant` signs the CLI out, Keycloak being down does not. `ask` reads the same SSE stream as the chat page (`src/shared/sse.ts`, shared with `src/client/chat/api.ts`) through the pure reducer `src/cli/turn.ts`; a draft that waits for review shows the inbox item, never the draft text. `inbox` and `decide` call the lesson 13 routes, so OpenFGA decides who may decide. Without a TTY, or with `--json`, output is plain. `npm run medinfo` runs it from source; `npm run build:cli` (part of `build`) writes `dist/cli/index.js`, the package `bin`.
- `20-rag`: `search_labels` reads the label PDFs (`data/hcp/pdf`, the manifest names each PDF's tenant, brand, status, date, country and source Markdown). `npm run rag:setup` creates the `vector` extension and starts docling-serve (compose profile `ingest`); `npm run rag:ingest` converts each PDF to Docling JSON, `readingOrder` (`src/server/rag/extract.ts`) orders the layout boxes column by column (Docling's own Markdown files a side-by-side table under the wrong section), cuts one chunk per numbered section, and `missingFromExtraction` fails the PDF unless every word of every source section came out; a failed PDF is not stored and nothing is removed. Chunks are embedded with `text-embedding-3-small` through the gateway and stored in `label_chunks` (migration 008, pgvector HNSW cosine), keyed by PDF sha256 and model, so an unchanged PDF makes no model call. `vectorSearch` (`src/server/rag/search.ts`) filters to the documents OpenFGA lets the asker read inside the query (`hnsw.iterative_scan = strict_order`) and drops hits under `MIN_SIMILARITY` 0.35 (measured: real questions 0.48 and up, the scraper request 0.26). The server and the dataset runner call `connectLabelIndex` at start and stop on an empty index with the command to run. Tests: `src/server/rag/rag.test.ts`, on real Docling output for two PDFs and a fake embedder.
- `21-citations`: every answer the agent writes is checked in code before it is final (`src/server/citations.ts`, the `cite` node in `src/server/graph.ts` after the agent and before `submit`). Each `[doc_id, section]` must be a section `search_labels` returned in this thread and `status` `active`; each dose, wait or rate (`quantities`) must appear in the text of the sections its sentence cites (else its paragraph's, else the answer's); a number the doctor gave is skipped. A failing answer gets one rewrite with the problems as feedback and no tools, streamed under the same message id; a second failure is replaced by `WITHHELD_REPLY`. The `cite` span's output and a CATEGORICAL `citations` score (passed, rewritten, withheld) are on the trace. `npm run citations:audit` replays stored answers from Langfuse through the check with no model calls (405 checked, 13 stopped when written). Tests: `src/server/citations.test.ts` on four real stored answers (`citations.fixtures.json`) and a fake model client, and `scripts/citations-audit.test.ts`.

What makes the checkpoints stitchable:

- The OpenAI SDK is already in place before tracing starts, so step 2 is only about observability.
- Prompt management falls back to the local prompt if the Langfuse prompt is absent.
- Monitoring depends on stable message arrays on the agent/generation observations and the root `answer` field, not provider-specific internals.
- Dataset items carry both `idealAnswer` and `expectedBehavior`, which feed the step-06 `correctness` (tags 00 to 08) and `behavior_match` callback evaluators.
- Dataset and experiment scripts reuse the same app logic as the web UI; experiment scores are produced by `runExperiment` callbacks in the runner process.

Recommended jump patterns:

- Short workshop: start at `checkpoint/01-base-app`, build tracing live, explain prompt management, and finish with monitoring.
- Full workshop: walk through all checkpoints in order.
- Catch-up jump: if a group gets stuck in tracing, jump straight to `checkpoint/04-monitoring` or `checkpoint/05-dataset` and continue from there.

## Syncing checkpoint tags

Every `checkpoint/*` tag is `main`'s tree except for its milestone files: the files whose code the next lesson changes. `scripts/sync-checkpoints.sh` sets this list in `milestone_files()`:

| Tags | Milestone files (kept from the tag) |
| --- | --- |
| `00-setup`, `01-base-app`, `02-tracing` | the untraced app (`index.ts`, `medinfo-agent.ts`, `tools.ts`), the runner, and the lesson 10 to 21 files |
| `03-prompt-management` | `medinfo-agent.ts` with no Langfuse prompt fetch, the runner, and the lesson 10 to 21 files |
| `04-monitoring` to `09-advanced-evals` | `medinfo-agent.ts`, the runner, and the lesson 10 to 21 files |
| `10-ai-gateway` | the lesson 11 to 21 files |
| `11-sign-in` | the lesson 12 to 21 files |
| `12-mcp-sandbox` | the lesson 13 to 21 files |
| `13-durable-review` | the lesson 14 to 21 files |
| `14-content-agents` | the lesson 15 to 21 files |
| `15-a2a` | the lesson 16 to 21 files |
| `16-events` | the lesson 17 to 21 files |
| `17-autonomy` | the lesson 18 to 21 files |
| `18-release-gate` | the lesson 19 to 21 files |
| `19-cli` | the lesson 20 and 21 files |
| `20-rag` | the lesson 21 files |
| `21-citations` | none (equal to `main`) |

The lesson 10 files are `GATEWAY_FILES` in the script, the lesson 11 files are `AUTH_FILES`, the lesson 12 files are `MCP_FILES`, the lesson 13 files are `TIER_FILES`, the lesson 14 files are `CONTENT_FILES`, the lesson 15 files are `A2A_FILES`, the lesson 16 files are `EVENT_FILES`, the lesson 17 files are `AUTO_FILES`, the lesson 18 files are `GATE_FILES`, the lesson 19 files are `CLI_FILES`, the lesson 20 files are `RAG_FILES`, and the lesson 21 files are `CITE_FILES`. A tag keeps its own `docs/scoreboard.md`, so the sync runs `scripts/align-scoreboard.ts` on it: a slice added by a later lesson becomes a column of dashes there. A milestone file a tag does not have stays absent on it, which is why `npm run check` finds its tests by glob, not by name.

Inside a milestone file, regions marked `// checkpoint-sync:begin <name>` / `// checkpoint-sync:end <name>` still come from `main`. The sync fails if `main` has a region that a tag's milestone file lacks. When a new lesson starts editing a file, add it to `milestone_files()` for the earlier tags.

The `Sync checkpoint tags` GitHub Action (`.github/workflows/sync-checkpoints.yml`) runs on every push to `main` (and by hand). It runs `npm ci`, then `./scripts/sync-checkpoints.sh --verify --push`. With `--verify`, every tag must pass `npm run check`, moved or not. Each changed tag gets one commit and is force-moved. With no `SOURCE_REF`, the script fetches and uses `origin/main`, never a local `main` that may be behind. All moved tags are pushed together, and only once every tag has passed. `.github/`, `scripts/sync-checkpoints.sh` and `scripts/align-scoreboard*.ts` stay on `main` only.

To run it locally (clean working tree required):

```bash
./scripts/sync-checkpoints.sh --verify          # update local tags only
./scripts/sync-checkpoints.sh --verify --push   # also force-push them
SOURCE_REF=my-branch ./scripts/sync-checkpoints.sh --verify
```

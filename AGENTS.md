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
| `00-setup`, `01-base-app`, `02-tracing` | the untraced app (`index.ts`, `medinfo-agent.ts`, `tools.ts`), the runner, and the lesson 10 to 13 files |
| `03-prompt-management` | `medinfo-agent.ts` with no Langfuse prompt fetch, the runner, and the lesson 10 to 13 files |
| `04-monitoring` to `09-advanced-evals` | `medinfo-agent.ts`, the runner, and the lesson 10 to 13 files |
| `10-ai-gateway` | the lesson 11, 12 and 13 files |
| `11-sign-in` | the lesson 12 and 13 files |
| `12-mcp-sandbox` | the lesson 13 files |
| `13-durable-review` | none (equal to `main`) |

The lesson 10 files are `GATEWAY_FILES` in the script, the lesson 11 files are `AUTH_FILES`, the lesson 12 files are `MCP_FILES`, and the lesson 13 files are `TIER_FILES`. A milestone file a tag does not have stays absent on it, which is why `npm run check` finds its tests by glob, not by name.

Inside a milestone file, regions marked `// checkpoint-sync:begin <name>` / `// checkpoint-sync:end <name>` still come from `main`. The sync fails if `main` has a region that a tag's milestone file lacks. When a new lesson starts editing a file, add it to `milestone_files()` for the earlier tags.

The `Sync checkpoint tags` GitHub Action (`.github/workflows/sync-checkpoints.yml`) runs on every push to `main` (and by hand). It runs `npm ci`, then `./scripts/sync-checkpoints.sh --verify --push`. Each changed tag gets one commit, must pass `npm run check`, and is force-moved. All moved tags are pushed together, and only once every tag has passed. `.github/` and `scripts/sync-checkpoints.sh` stay on `main` only.

To run it locally (clean working tree required):

```bash
./scripts/sync-checkpoints.sh --verify          # update local tags only
./scripts/sync-checkpoints.sh --verify --push   # also force-push them
SOURCE_REF=my-branch ./scripts/sync-checkpoints.sh --verify
```

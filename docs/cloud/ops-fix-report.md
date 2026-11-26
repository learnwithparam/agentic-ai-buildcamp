# Ops measure fix

Branch `cloud/ops-fix`. No gateway here, so the real measure is not run. The orchestrator runs `npm run ops:measure` on the laptop.

## Why the real run read $0 and 0 calls

`runMedinfoTurn` already wraps its graph in `measureTurn` (it sends the turn scores). `scripts/ops-eval.ts` wrapped it in a second `measureTurn`. The inner meter hid the calls from the outer one, so the outer turn saw none. The wall time was right, because it is read in the outer turn. The counter itself was attached to the client. Counting through `modelClient` already worked.

## What I changed

- `src/server/ops/meter.ts`: a turn inside a turn now reports its calls, cost and stages to every turn around it. The outer turn also waits for the inner calls to be read.
- `src/server/gateway.ts`: the one counting door. `modelClient` and `embed` were already counted there. The behavior decision (`decide`) went straight to `fetch`. It is now counted here too.
- `scripts/ops-eval.ts`: `toRun` fails when any turn made zero model calls, as well as when a call has no cost. The run file now has `turns` (seconds, calls, cost and stages per turn) and `stage_summary` (count, median, p95 and total per stage, slowest total first). The script prints that table.
- Stage timings (`timed` in `meter.ts`): `router`, `query_rewrite`, `embedding`, `search_grading`, `search_grading_retry`, `tool:<name>`, `answer`, `claim_check` (with `claim_extract` and `claim_judge` inside it), `citation_retry`, `claim_check_retry`, `safety_report`. A stage nested in another is counted in both, so totals do not add up to the turn.
- Speed:
  - The tools of one model message run at the same time (`toolsStep`). The results keep the order of the calls.
  - `extractClaims` asks no model when the answer has no words.
  - Output caps (`OUTPUT_CAP` in `gateway.ts`) on the router (800), the query rewrite (400), the search grader (1500) and the claim support judge (300). Each is several times what a good answer needs.
- Already parallel, left as is: the vector and keyword search, and the claim judges (one per claim).
- No check was dropped and no check decides differently.

## Tests, and whether I saw them red first

New: `src/server/ops/count.test.ts`. Added to `scripts/ops-eval.test.ts`. Run before the fix:

| Test | Red first |
| --- | --- |
| a turn with zero calls fails `toRun` | yes |
| the run file has stage timings and a summary | yes |
| a turn inside a turn adds its calls to the outer turn | yes (the cause above) |
| stages are timed, also when the stage throws, also in the outer turn | yes (`timed` did not exist) |
| a stage that needs a short answer sends a cap | yes |
| an empty answer asks no model for claims | yes |
| a call made through `modelClient` by any module is counted (rewrite, grader, claims, embed) | **no**, it passed before. It is a guard: the counting was never the fault. |
| tools of one message run at the same time, in order | **no** in my first version (delays too short to tell). I lengthened them so a one-after-another run fails (240 ms against a 200 ms limit). I did not break the code again to see that red. |

## Tests run

- `npm run typecheck`: passes.
- `scripts/**/*.test.ts` and `src/**/*.test.ts`: 209 pass, 20 fail. On the untouched branch the same files fail (200 pass, 20 fail, the same ones), so the 20 are not from this change. They need services: OpenFGA (`permissions`, `inbox`, `mcp`, `content`, `a2a`, `events`, `durable`, `sessions`, `auth`), Postgres or pgvector (`ops-db`, `rag`, `bi`), and Langfuse (`sweep`).
- `scripts/check-repo.ts`: passes. `ops-eval.ts --fake`: runs.

## Not run

- `npm run ops:measure` (needs the gateway, the label index, OpenFGA, Keycloak).
- `check:live`, `check:pages` (mermaid), the services tests above.
- Not verified: the gateway accepts `max_tokens` for this model. If the model counts hidden reasoning against it, a cap could cut an answer and show up as a parse failure. If the next run shows parse failures, raise `OUTPUT_CAP` first.

## Where I expect the time to go

I have not measured this. Read the stage table in the next run.

1. `answer` and `citation_retry`. The agent writes the whole answer, streamed, and often twice (one round of tools, then the answer). A retry costs a full second answer.
2. `claim_check`. It is one model call that lists claims, then one judge call per claim, run together. The slowest judge sets the time. It runs after the answer, so the doctor waits for it.
3. `search_grading`. It reads 30 sections in one call. The input is long. A miscount retry doubles it.
4. `router`. One call before anything else, every turn.
5. `query_rewrite` and `embedding`. Short. The rewrite only runs on follow-ups.

The long tail (48 to 60 s) looks like turns with a retry, a second tool round, or a rewrite. The `turns` list in the run file shows which stages those turns had.

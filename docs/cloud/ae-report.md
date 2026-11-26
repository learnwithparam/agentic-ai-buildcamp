# Adverse events (part ae): report

Branch `cloud/ae`, built on `origin/search-hybrid` (d89c00a). Nothing here was run on a real model, so there is no measured number. The orchestrator measures.

## What I built

1. **Two layers.** The router is unchanged. `withSecondPass` (`src/server/tiers.ts`) reads every message the router sent to `answer` with one `json_schema` call (`detectEvent`, `src/server/safety/detect.ts`) that asks only whether something happened to a patient after a medicine. Wording is indirect and special situations are named (pregnancy exposure, overdose, medication error, lack of effect, off label use). A yes from either layer gives tier `safety`. The pure rule is `raiseToSafety`. It only raises `answer`, and never lowers a tier. `detectEvent` has its own input and output, so `ae:measure` scores it alone.
2. **Extraction and coding.** `src/server/safety/extract.ts`: the model fills fields (reporter role, patient age, sex and label, product, events with a proposed term, special situation, seriousness). Code decides each of the four ICH E2D(R1) criteria from those fields. `src/server/safety/meddra.ts` loads `data/hcp/safety/meddra-synthetic.json`. The model may only pick a term from the dictionary's LLT names (a schema enum), code maps it to LLT, PT and SOC, and `byLltCode` and `byPtCode` throw `UnknownCode` for any code not in the file. A term with no match gets no code, and its reported words stay.
3. **E2B(R3)-shaped draft.** `src/server/safety/e2b.ts`: built in code. It is marked `status="draft" submitted="false"` and says it was not submitted. Every element carries an ID and name from the table `E2B_ELEMENTS` (C.1.1 to C.1.5, C.2.r.4, D.1, D.2.2a/b, D.5, E.i.1.1a, E.i.2.1a/b, E.i.3.2a to f, G.k.1, G.k.2.2, H.1), and a test fails if the XML uses any other. Missing elements are left out and listed, not invented. **Limit:** I wrote the element IDs and names from my knowledge of the E2B(R3) guide. I could not fetch the ICH list here, so they are not machine-checked against it, and the layout is flat `<dataElement>` XML, not the HL7 v3 message. Please check the table against the guide.
4. **Clock.** Migration `012_safety_escalation.sql` adds status `escalated`, `review_items.escalated_at` and the table `safety_notifications` (unique per item and kind: `raised`, `escalated`). `src/server/safety/clock.ts` has `escalateOverdue(pool, now)` and `startSafetyClock` (every 60 s, started in `src/server/index.ts`). It touches only `adverse_event` items with status `waiting` and `due_at` in the past. `ReviewStore.submit` writes the `raised` row for adverse events only. `waitingFor` and `decide` accept `waiting` or `escalated`, so an escalated item stays in the inbox and is decided once. The inbox page and CLI show the new status.
5. **Wiring.** The router node calls the second pass. The safety node calls `reviewerDraft` (`src/server/safety/draft.ts`), a third model call that appends the criteria, coded events and XML draft under the fixed reply in the inbox item. If it fails, the report is still filed with a "CASE DRAFT NOT MADE" line.
6. **Measure.** `scripts/ae-eval.ts`, `npm run ae:measure`.

## Files

New: `src/server/safety/{meddra,detect,extract,e2b,clock,draft}.ts`, `src/server/migrations/012_safety_escalation.sql`, `scripts/ae-eval.ts`, tests listed below, this report.
Edited: `src/server/tiers.ts` (added `raiseToSafety`, `withSecondPass`), `src/server/medinfo-agent.ts` (router and safety node, 4 lines), `src/server/reviews.ts` (status, `escalatedAt`, `raised` row), `src/server/index.ts` (start the clock), `src/client/chat/api.ts`, `src/client/inbox/Inbox.tsx`, `src/cli/ui.tsx` (treat `escalated` as open), `package.json` (`ae:measure`), `docs/learner/13-durable-state-and-review.md` (two short paragraphs, passes `plain-english`, `glossary` and `lesson-shape`).

## Tests, and whether I saw each fail first

All were broken on purpose, seen red, and restored.

| Test file | What it proves | Red first |
| --- | --- | --- |
| `src/server/safety/meddra.test.ts` | unknown codes refused; terms map to LLT, PT, SOC; every labelled PT codes; bad dictionary refused at load | yes: `byLltCode` made to return a fallback |
| `src/server/safety/e2b.test.ts` | required elements present; only listed element names; draft marker; escaping; missing items listed; unknown term gets no code | yes: removed G.k.2.2, removed `<` escaping, set `submitted="true"` |
| `src/server/safety/clock.test.ts` (Postgres) | overdue escalated with a second notice row; not due, decided and other kinds untouched; idempotent; escalated item decided once; draft decisions unchanged | yes: removed the `due_at` filter, removed the kind filter, broke the notice insert |
| `src/server/safety/layers.test.ts` | either layer routes to safety; both no stays answer; review and stop keep their tier | yes: made `raiseToSafety` do nothing, removed the `answer` guard |
| `scripts/ae-eval.test.ts` | recall, precision, per layer, criteria, coding arithmetic; `--fake` numbers on the 79 rows | yes: router-only recall, a coding denominator |
| `src/server/safety/safety.live.ts` | second pass and extraction on the real model, 9 rows | **never run** (no gateway). Not seen red or green. |

`npm run typecheck` passes. `npm run check`: the tests above pass. 24 tests fail, the same 24 as on `origin/search-hybrid` before my change (checked by running both): permission rules, a2a, inbox, mcp, content, and the bi tests. They need OpenFGA, Keycloak or the bi logins and data.

## Could not run

- OpenFGA: the release download returned Not Found (the `latest/download` path I tried), so `inbox.test.ts`, `permissions`, `a2a`, `mcp`, `content` and the review routes were not exercised. `ReviewStore.waitingFor` with `escalated` is untested against OpenFGA. `decide` is tested.
- Docker, Keycloak, Langfuse, the gateway: absent. `safety.live.ts` and every real-model run are unrun. Migration 009 needs the `bi_pharma_a` and `bi_pharma_b` logins, so I created them by hand in the local Postgres.
- `npm run check:pages` stops at `mmdc` (not installed). I changed no diagram. The text checks pass.
- The pre-push gate: not run (hooksPath unset, as told).

## Measure

```
npm run ae:measure            # real model through the gateway, writes docs/runs/ae.json
npm run ae:measure -- --fake  # no model, writes nothing; arithmetic only
```

It needs `TEST_DATABASE_URL` (or `DATABASE_URL`) for the clock probe. The probe plants rows under a unique thread and deletes them, but the job it runs also escalates any other overdue adverse event in that database, so point it at the test database. `--fake` predictions come from the labels with planted mistakes. It makes no stand-in model client.

Definitions (also in the script header): a positive is `expected_route === "safety"`, which includes the five special-situation rows that are not adverse events by `is_adverse_event`. `recall` and `precision` count either layer. `criteria_accuracy` is per criterion and row, and `criteria_all_four` (also written) is the strict version. `coding_accuracy` is the PT overlap (found over found or expected) on rows that expect terms. `overdue_escalated` is 0 if any control item was touched. The run file also holds each layer alone, the clock result and the miss list.

## Left out

- Real MedDRA (licence), the HL7 v3 schema and a validator, gateway submission of the XML.
- A sync-script update: `scripts/sync-checkpoints.sh` has no file list for `src/server/safety/`, and `tiers.ts` and `medinfo-agent.ts` now import it. Tags that carry those two files need the safety files too. Not touched (not mine).
- `docs/measures.md` and `docs/runs/*.json`: untouched.
- Reviewer-side editing of the draft, and follow-up questions to the reporter for missing criteria (the missing list is shown, nothing is sent).
- The `review` tier: a draft request that also describes an event goes to review, as before. The second pass reads `answer` only, as the brief says.

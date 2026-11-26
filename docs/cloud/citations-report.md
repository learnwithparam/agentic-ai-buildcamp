# Citations part: report

Branch `cloud/citations`, from `origin/main` at 18eeb63.

## What I built

A claim check on every final answer, after the existing number check.

1. The answer's claims are listed as `{ text, quote, docId, section }`.
2. Code checks each claim (`checkClaim`): the section exists in `LABEL_SECTIONS`; a search returned it this turn; its document is in force on the turn's day; (optional) it is for the asker's country; the quote is in the section after whitespace and case folding only; every number in the claim is in the quote (a number the doctor gave, and digits inside a name such as CYP3A4, do not count).
3. A claim that passes goes to the support judge: one `json_schema` call through `modelClient()`, temperature 0, labels `supported` / `unsupported`.
4. A failing claim becomes a `{ kind: "claim", reason, citation, claim }` problem. It joins the number problems in `citeStep`, so the existing path applies: one rewrite with the reasons as feedback, then `WITHHELD_REPLY`. The reasons are in `CitationOutcome.problems` and in the run panel (`plainProblem`).

## Files

- new `src/server/citations.claims.ts`: types, `checkClaim`, `quoteIsVerbatim`, `reviewClaims`, `judgeWithModel`, `extractClaims`, `claimCheckWith`
- new `scripts/citations-eval.ts` (`npm run citations:measure`), `scripts/citations-eval.test.ts`
- new `src/server/citations.claims.test.ts`, `src/server/citations.claims.live.ts`
- edited, small: `src/server/citations.ts` (new problem kind, `CLAIM_REASONS`), `src/server/graph.ts` (`citeStep` takes an optional `claimCheck`), `src/server/medinfo-agent.ts` (`citeNode` passes it), `src/shared/run.ts` (`plainProblem` case), `package.json` (script), `docs/learner/21-citations.md` (two bullets, because `check-repo` needs the script shown)

## Where I did not follow the brief to the letter

- **Claims come from a second call, not from the agent's answer schema.** The agent streams its answer as text to the chat. Making that answer JSON would break the stream and the UI. So `extractClaims` (one `json_schema` call, temperature 0) lists the claims, with verbatim quotes, from the finished answer and the sections found. The code checks do not trust it: a made-up quote fails the verbatim check. If you want the agent itself to emit `claims[]`, that is a bigger change to `medinfo-agent.ts` and the chat stream.
- **`--fake` repeats the row's label; it is not a model client.** `scripts/no-fake-model.test.ts` forbids stand-in model clients, so the tests pass plain functions (`labelJudge`, `async () => "unsupported"`), not objects shaped like the OpenAI client. `--fake` writes `docs/runs/citations.fake.json`, never `citations.json`, so it cannot fill a measures row by mistake.
- **The rewrite-then-withhold path has no offline test.** `citeStep` calls the real model for the rewrite, and the repo forbids a fake one. I did not change that control flow: the claim problems join `problems` and `afterRewrite`, which the existing path already rewrites and withholds. `citations.claims.live.ts` covers the judge, the listing and a `claimCheckWith` call on the real model. A live test of the whole rewrite then withhold is not written.
- The country rule is extra: the gold file has 9 `wrong_country` rows and the brief's rule list does not catch them without it. In the live path it is off (a search is already limited to the asker's country).

## Tests, and whether I saw each fail first

Red first, by breaking the code, seeing the test fail, restoring:

| Break | Tests that went red |
| --- | --- |
| fold without lowercase | whitespace and case |
| number rule removed | number not in quote; given number and CYP3A4 |
| in-force rule removed | in-force; gold run with the label judge |
| retrieved rule removed | section no search returned |
| judge never asked | claim whose quote passes is judged |
| recall denominator wrong | by-hand arithmetic; gold run |

Other tests in `citations.claims.test.ts` (every real gold quote verbatim and no fabricated one; a fabricated quote fails; one changed word fails; wrong country; failed claims never reach the judge) passed on the first run. I did not see each of them fail on its own.

`npm run typecheck` passes. `npm run check`: 181 pass, 65 fail, 27 cancelled. Baseline with my changes stashed: 167 pass, 65 fail, 27 cancelled. The 65 failures are the same with and without my change: they need Keycloak, OpenFGA and Docker (permissions, a2a, auth, events, sweep, bi, content). `npx tsx scripts/check-repo.ts` passes. `npm run check:pages` passes up to its last step: `mmdc` is not installed, and I changed no diagram.

## Could not run

- Keycloak, OpenFGA, Docker, Langfuse and the gateway are not available. I did not try the OpenFGA binary; the tests that need it fail as in the baseline.
- Postgres 16 and pgvector are installed and a `medinfo` database exists, but nothing in this part needs them.
- `src/server/citations.claims.live.ts` was not run (no gateway). Its 3 tests are unproven.
- `scripts/citations-replay.ts` runs `citeNode`, which now includes the claim check, on the real model. I did not run it. `data/evidence/citations-replay.json` may need re-recording.

## Measure

```
npm run citations:measure
```

Writes `docs/runs/citations.json` (`measures`, `judge_agreement`, `judge_by_label`, `misses`). Offline arithmetic: `npm run citations:measure -- --fake` (the label judge gives precision 1, recall 1, verbatim rate 1; the code checks alone flag all fabricated, wrong-version and wrong-country rows and 16 of 17 wrong-number rows, so the 17 unsupported rows and 1 wrong-number row depend on the judge).

The real-model numbers are the orchestrator's. The judge is asked about every gold row in the measure, so its agreement can be read per label. Precision and recall use the pipeline rule: a row is flagged if the code or the judge flags it.

## Left out

- No change to `docs/measures.md` or the other run files.
- No new dataset file: `data/hcp/gold/claims.jsonl` was enough.
- The lesson page has two bullets about the claim check and nothing more. Its diagrams still show the number check only.
- The run panel shows the reasons through the existing `check.problems` list. I did not touch the client.

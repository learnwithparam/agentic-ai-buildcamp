# Evals part: report

Branch `cloud/evals`, built on `origin/search-hybrid`. Nothing here was measured on a real model.

## What I built

1. **No assert is dropped.** `scripts/hcp-cases.ts` now keeps every `llm-rubric` assert as `expectedOutput.rubrics`, and stops the load with the file, the case and the type for any assert type outside `HANDLED_ASSERTS` (the four text checks and `llm-rubric`).
2. **A rubric judge.** `scripts/judge/rubric.ts` scores each rubric through `modelClient()`. `scripts/experiment.ts` adds a `rubric_match` score to every case that has rubrics, and `failedScores` requires it, so a missing or failing rubric fails the case. `startExperiment` also stops when a hosted dataset item holds different rubrics from the yaml (`staleRubrics`), naming each case, with the command `npm run dataset:seed`.
3. **Calibration set of 60.** `scripts/eval-calibration.ts` builds 60 candidate answers from the dataset by a rule and writes `data/calibration/rubric-labels.tsv` with two empty labeller columns. It also holds the arithmetic: labeller kappa and raw agreement, the consensus rows, and the judge's agreement with the consensus.
4. **Release gate on every slice.** `scripts/eval-release.ts` picks one case per slice (holdout first, then showcase, then lowest id). `RELEASE_CASES` in `scripts/release-gate.ts` is now that pick: 22 cases for 22 slices.
5. **Sabotage run.** `npm run release:gate -- --sabotage` removes the citation line and every defer rule from the production prompt (`scripts/eval-sabotage.ts`), saves it as a version under the label `sabotage`, and runs the release cases on it. Red exits 1; a gate that stays green exits 3. It never promotes.
6. **pass^5.** `scripts/eval-passk.ts` (`npm run evals:measure`) runs the demo set (release cases plus every showcase case, 34 cases) 5 times, then the sabotage run, then the judge on the labelled rows, and writes `docs/runs/evals.json`. It holds `measures` in the shape of `search.json`, plus `pass_rate` per slice, `pass_hat_5`, `sabotage_caught`, `judge_agreement`, the floor check and the judge's calibration problems.
7. **Frozen floor.** `data/evals/floor.json` holds 0.9 and 0.8; a test fails when they differ from the targets in `docs/measures.md`.
8. **Offline mode.** `--fake` runs a scripted agent (`scripts/eval-scripted.ts`, `scripts/eval-agents.ts`) with no model. It decides a case from the prompt text and the case's own checks, so it proves the arithmetic and the gate wiring only. It is not named like a model client, so `no-fake-model.test.ts` still passes.

## Files

New: `scripts/eval-asserts.ts`, `eval-agents.ts`, `eval-calibration.ts`, `eval-passk.ts`, `eval-release.ts`, `eval-sabotage.ts`, `eval-scripted.ts`, `scripts/judge/rubric.ts`, their tests (`eval-*.test.ts`), `data/evals/floor.json`, `data/calibration/rubric-labels.tsv`, `docs/cloud/evals-dataset.md`.
Changed: `scripts/hcp-cases.ts` (rubrics, loud failure, `loadCases(agent, dir)`), `scripts/experiment.ts` (rubric score, stale check), `scripts/release-gate.ts` (rule-based cases, `--sabotage`, `runReleaseCases`), `scripts/release-gate.test.ts` (no hard-coded ids), `package.json` (`evals:measure`, `evals:candidates`), `scripts/sync-checkpoints.sh` (the new files join `GATE_FILES`, so tags before lesson 18 do not receive tests for code they lack), `docs/learner/18-release-gate.md`.
`scripts/run-dataset.ts` and `scripts/judge-calibrate.ts` needed no edit: the first calls the shared experiment, the second measures the faithfulness judge, which is unchanged.

## Tests, and whether I saw each fail first

I broke the code, ran the test, saw red, and restored. Each line is a break and the tests that went red.

- `eval-asserts.test.ts`: removing `llm-rubric` from `HANDLED_ASSERTS` turned the whole-directory walk red (the walk found 11 asserts nobody handles). Disabling the loader's throw turned the unknown-type test red. Setting `rubrics: []` turned the rubric-count and stale-dataset tests red. Making `staleRubrics` return nothing turned its test red. Making the rubric outcome ignore a failed verdict turned the judge test red.
- `eval-release.test.ts`: keeping only 5 slices turned slice coverage red. Preferring train over holdout turned the rule test red.
- `eval-sabotage.test.ts`: dropping only the defer lines turned the sabotage test red. Making `assertReleasable` never throw turned "red on the sabotaged prompt" and the scripted-agent test red. Removing the "no defer rule" guard turned the refusal test red.
- `eval-passk.test.ts`: replacing `C(c,k)/C(n,k)` with `c/n` turned five tests red. Changing the pass-rate divisor turned three red. Hard-coding `sabotage_caught` turned the "agent the sabotage does not turn red" test red. Lowering `floor.json` to 0.85 turned the floor test red.
- `eval-calibration.test.ts`: inverting raw agreement turned the kappa and judge tests red. Counting every row as consensus turned the hand-worked example red. Removing the "60 labels" rule turned the calibration-status test red.

`npx tsc --noEmit` passes. `npm run check:pages` passes except the last step: `mmdc` is not installed here, so the one diagram line I changed in lesson 18 ("Run the release cases") was not rendered. `scripts/check-repo.ts` passes.

## Tests I could not run

`npm run check` stops at 19 failing tests, the same 19 with and without my changes (I ran the full suite on a stashed tree to compare). All need `FGA_API_TOKEN`, OpenFGA, Keycloak, Postgres with the identity setup, or Docker: `permissions.test.ts`, `auth.test.ts`, `a2a.test.ts`, `sweep.test.ts`, `bi.test.ts`, `content.test.ts`, `durable.test.ts`, `events.test.ts`, `inbox.test.ts`, `mcp.test.ts`, `rag.test.ts`, `sessions.test.ts`. I did not set up OpenFGA or Postgres: none of my tests need them.
Not run at all: `release-gate.ts` itself (it needs Langfuse and the gateway), so the `--sabotage` branch of its `main` is untested beyond the pure functions it calls. `evals:measure` against the real model, `check:live`, and the rubric judge on a real model.

## What the orchestrator must do

1. Re-seed the dataset so hosted items carry rubrics: `npm run dataset:seed`. Until then the runner stops with "The hosted dataset is out of date".
2. **Label 60 rows.** Two people fill `labeller_a` and `labeller_b` in `data/calibration/rubric-labels.tsv` with `pass` or `fail`. For each row: does the `answer` meet the `criterion` for the `question`? Do not open the last column `edit` before labelling; it says how I made the answer. 27 rows are the case's ideal answer, 33 are copies with one change (a number doubled, a leading No/Yes flipped, a refusal, or the first sentence only). Check with `npm run evals:candidates -- --check`.
3. Run the measure: `npm run evals:measure` (add `-- --label staging` to measure another prompt label). It writes `docs/runs/evals.json`. `evals.judge_agreement` is written only once the rows are labelled, so the measures row stays pending until then.
4. Fill the four `evals.*` rows in `docs/measures.md` from that file.
5. Run `npm run release:gate -- --sabotage` once; it should print "red on the sabotaged prompt" and exit 1.

## Things to watch in the first real run

- **The gate now runs 22 cases and prefers holdout cases.** The old 8 were known green. A holdout case may fail on the real model, so the first gate run may be red for a reason unrelated to the sabotage. If so, read the failing case rather than changing the rule.
- **The sabotage may not turn the gate red.** Lesson 21's `cite` node checks citations in code, so removing the prompt's citation line may not change what the doctor sees. If `sabotage_caught` is 0, that is a finding about the gate or about the prompt's role, not a bug in the script.
- **The sabotage creates a prompt version** under the label `sabotage` each time it runs. Production and staging labels do not move.
- **The rubric judge is not yet calibrated.** Until labels exist, every run prints "rubric judge not calibrated" and `docs/runs/evals.json` lists the reasons under `judge.problems`. It still scores the rubrics; it does not claim a bar it has not met.
- `judge_agreement` is the judge against the rows where both labellers agree. Disputed rows are listed (`judge.disputed`) and never counted against the judge.

## Left out

- The judge calibration set is 60 candidates, not labelled ones. I could not label.
- Five rubric cases (FACT-04, FACT-05, OUTREACH-02, OUTREACH-03, OUTREACH-05) have no `idealAnswer`, so the set holds no candidates for them. `docs/cloud/evals-dataset.md` says what to add to the dataset repo.
- `docs/learner/18-release-gate.md` is edited so no sentence claims 8 hand-picked cases, but the recorded scoreboard row and the red/green walk-through in it come from the old gate. They need a fresh run, which only the orchestrator can make. Lessons 06 and 09 are untouched.
- `JUDGED_SLICES` and the faithfulness judge are unchanged.
- Checkpoint tags: I added the new files to `GATE_FILES` in `scripts/sync-checkpoints.sh`, but did not run the sync. `hcp-cases.ts` is copied to every tag from main, so tags before 18 get the loud failure and the `rubrics` field; their old runner ignores `rubrics`.

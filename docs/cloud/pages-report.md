# Pages report (phase E)

## What I built

- `npm run scoreboard` (`scripts/scoreboard.ts`): builds `docs/scoreboard.md` from `docs/runs/scoreboard-<chapter>.json`, one file per row. The header and cell shape are the ones check-repo already expects. `dataset:run --reference` now saves a run file and rebuilds the table, so the table is never typed by hand. Lesson 06 shows the command.
- `docs/runs/scoreboard-*.json` (15 files): made from the rows that were already in `docs/scoreboard.md`. I did not run the model. The numbers are the old rows, now in a file a check can read.
- `docs/runs/faithfulness.json`: the lesson 09 numbers (19 of 21 agreed, kappa 0.81, bar 0.6). They are computed from the stored `data/calibration/faithfulness.json`. `judge:calibrate --save` writes it, and a test checks it matches the calibration.
- `scripts/page-numbers.ts`, in `npm run check:pages` and in the list in `scripts/page-checks.test.ts`:
  - `22<!-- from: docs/runs/x.json#passed -->` fails when the number differs from the run value (at the shown digits, `%` means a share), when the file or path is missing, or when no number sits before the comment. Dotted keys like `search.recall_at_5` resolve.
  - `<!-- from-row: docs/runs/scoreboard-07.json -->` at the end of a scoreboard table row checks the chapter, Passed and every slice cell. I added it so the 30-odd copied rows are checked, not skipped. All of them matched.
- `plain-english.ts` now ignores HTML comments, so a from-comment is not counted as words or sentences.
- Two small guards: every `npm run X` a page names must exist in package.json, and the faithfulness run file test.
- Removed `scripts/.diag/ae-diag.ts`, a stray tracked scratch file that imported missing modules. It made check-repo and the gateway test fail on main.

## Numbers changed or removed

- Lesson 21 and walkthrough: 405 and 428 were the same count read at two times, and no run file holds it. Removed. The audit output shows `<N> answers checked, <M> would be stopped.`, and the per-kind counts are `<n>`. Also removed "6 of 9", "13 stored answers" and "13 replayed: 12 rewritten, 1 withheld".
- Scoreboard 28 against 38: 28 is the case count of the 06 and 07 rows, now cited from the run files. "Your run scores all 38" is gone. The lessons say "every case in the dataset". Lesson 00 lost its 28. Lesson 10 cites 28. Lesson 07 lost "other 26" and "same 28 cases" in prose and the diagram.
- Lessons 07, 08: 5, 22 and 28 now cite the 06 and 07 run files. Diagram labels with counts lost them (a diagram cannot hold a comment).
- Lesson 09: 19/21 and kappa 0.81 now cite `faithfulness.json`. The confusion matrix block is gone. The batch numbers (0.61, 0.80, 0.80, 0.90) and "7 of 9" came from batches no file holds, so they are now words.
- Lesson 11: "2/4 to 4/4, 0/4 to 4/4" became "pass every case". Lessons 13 to 17: bullet tallies (7/7, 5/6 and so on) dropped, since the row above holds them. Lesson 18: 0.625, 0.63 and 1.00 (red run, no file) became words, and 8/8 cites run 18.
- Lesson 20: the search table and the quoted recall, MRR, out-of-label, follow-up (0.878, 0.955), cross-doc (0.788) and version (0.917) numbers cite `search.json`. History numbers from earlier grader runs (0.75, 0.924, 0.958, 0.933, 0.015, 25 of 30, 32 grades, 0.60) became words.
- Lesson 23: `70 items / 0.914 / 0.957` block, "3 of 10", "10 of 10", "4 sections at 0.65" and "7 misses" removed. 63 of 70 and 70 cite run 23.
- Walkthrough diagram: the browser gets a session cookie, not a token. I added that.

## Brief items that were already right

- `npm run doctor` exists in package.json. `rag:fixtures` is named nowhere. No change; a test now keeps every named `npm run` real.
- Port 8787 is the API server (`env.ts`, the vite proxy), and 3333 is the app. The pages use each correctly. The canvas text is not in this repo (`lwp-canvas` draws it from `docs/flows`), so I could not fix it. It needs the same two checks there: 8787 versus 3333, and cookie versus token for the browser.
- Left unchanged on purpose: sample outputs of commands (confidence 0.97, spend 0.0071 USD), settings (0.50 USD budget, 25% sampling, the 0.6 bar) and counts of design (21 answers in the set, 8 release cases).

## Tests I saw fail first

- `page-numbers.test.ts`: red with "Cannot find module" before the script existed, then green. The from-row tests went red (1 fail) with row checking switched off, then green.
- `scoreboard.test.ts` (build and run file): red on the missing exports, then green.
- `page-checks.test.ts`: the wiring test went red (1 fail) before `page-numbers` was in `check:pages`. The from-comment prose test went red before comments were ignored.
- Not seen red: the faithfulness run-file test and the `npm run` names test. They passed on first run.

## What I could not run

- No model or Langfuse run, so no new run files. The 15 scoreboard files come from existing rows.
- The 19 tests that need Keycloak, OpenFGA, Postgres or Docker fail as on main (`TEST_DATABASE_URL`). Everything else passes (184 of 203).
- `mmdc` is not installed here. I installed it and ran `scripts/mermaid.ts` with the preinstalled Chromium: 25 pages render.
- `npm run check` stops at the database tests. I ran its parts apart: typecheck, tests, check-repo and check:pages all passed apart from those tests.
- Checkpoint tags are untouched. After merge, the sync action must copy docs, scripts and package.json to every tag. Not run here.

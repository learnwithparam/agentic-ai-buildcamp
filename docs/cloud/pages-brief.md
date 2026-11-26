# Pages part (phase E): numbers on pages come from runs

Work from origin/main. Push to branch `cloud/pages`; the pre-push gate skips cloud/* branches. Never force push. Plain English, no em dashes. Never edit `data/hcp` gold files.

## Build

1. `npm run scoreboard`: builds `docs/scoreboard.md` from `docs/runs/*.json`. Keep the table shape check-repo expects (one cell per slice), add the script to package.json, and show it on the page that teaches it so check-repo sees it used.
2. A page cites a number with a comment right after it: `<!-- from: docs/runs/x.json#dotted.path -->`. Add `scripts/page-numbers.ts`, wired into `npm run check:pages` and into the list in `scripts/page-checks.test.ts`. It fails when the number before the comment differs from the run value (compared at the shown precision), or when the path is missing. Write offline tests that show it red on a wrong number and on a missing path, then green.
3. Sweep `docs/learner/*.md`, `docs/walkthrough.md` and `README.md`. Every measured number (recall, precision, pass counts, scores) either gets a from-comment pointing at a real run value, or loses the number. These are known to be wrong:
   - lesson 21 says 405 and later 428 for the same count;
   - the scoreboard says 28 against 38;
   - page 00 names a `doctor` command, and page 20 names `npm run rag:fixtures` (check package.json and fix the page, not the scripts);
   - the canvas text says port 8787, and token where it means cookie (check the code).
4. Titles: every page title already drops its number, and `lesson-shape.ts` enforces that. Leave them.

## Done

`npm run check`, `npx tsx scripts/check-repo.ts` and `npm run check:pages` pass. The 65 tests that need Keycloak, OpenFGA or Docker may still fail, as on main. Write `docs/cloud/pages-report.md` covering:
- what you built;
- each number you changed or removed, and why;
- each test you saw fail first;
- what you could not run.

Commit it with your work on `cloud/pages`.

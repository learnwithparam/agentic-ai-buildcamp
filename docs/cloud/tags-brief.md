# Tags part (phase B): one start tag per lesson

Work from origin/main. Push to branch `cloud/tags`; the pre-push gate skips cloud/* branches. Never push tags, never run `sync-checkpoints.sh` with `--push`, never force push. Plain English, no em dashes.

## Goal

Tag N (`checkpoint/NN-*`) is the start of lesson N, the way langfuse-workshop does it. It holds what lessons before N built and none of lesson N's own files. Tags 00 to 08 already follow this. From lesson 10 on, each tag holds its own lesson's finished code (`gateway.ts` first appears on 10, `auth.ts` on 11). Sync also copies main's files into every tag unless a list keeps them out, so early tags carry later scripts, all eval cases, and package.json scripts that point at missing files.

## Build

1. `scripts/lesson-files.json`: for every tracked file on main, the lesson that adds it. Decide from each `docs/learner/NN-*.md` page and from `git log`/`git show` on the existing tags. A file several lessons change keeps one version per lesson only when its content really differs.
2. Make `scripts/sync-checkpoints.sh` (and any helper it calls) build each tag from that file. Tag N gets the files owned by earlier lessons, only the package.json scripts whose files exist on that tag, and only the eval cases from earlier lessons.
3. Offline tests in `scripts/sync-checkpoints.test.ts` that fail when:
   - a tracked file on main has no owner;
   - an npm script's file is missing on the tag it ships on;
   - a page's "you add" files are present on its own tag or missing on the next;
   - a tag carries eval cases from a later lesson.
   Break the code and show each test red, then green. Record that in the report.
4. Pages 10 to 22 become builds: check out the tag, add the named parts, run the check, compare with the next tag. Extend `scripts/lesson-shape.ts` so a page whose tag already holds its "you add" files fails.
5. Remove the stray `checkpoint/08-wrap-up` mention from README and the sync script. Deleting the tag itself is the orchestrator's job.
6. Build the tags locally only (`--verify` where it needs no stack), and report what each tag holds.

## Done

`npm run check`, `npx tsx scripts/check-repo.ts` and `npm run check:pages` pass. The 65 tests that need Keycloak, OpenFGA or Docker may still fail, as on main. Write `docs/cloud/tags-report.md` covering:
- what you built;
- where you did not follow this brief;
- each test you saw fail first;
- what you could not run.

Commit it with your work on `cloud/tags`.

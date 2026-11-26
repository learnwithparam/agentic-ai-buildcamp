# Release gate crash fix

## The bug

`scripts/release-gate.ts` ended with `void main()`. If main threw, for example when a Langfuse score write timed out, the run printed its first line and then ended with exit code 0. The pre-push hook read that as a pass, so the push went through untested.

## What changed

- New helper `scripts/run-main.ts`. `runMain(main, { name })` runs main. If main throws, it prints `<name>: did not finish, so this is NOT a pass. <reason>` and exits 1. A clean verdict is untouched: a red gate still sets its own exit code and returns.
- The release gate now starts with `runMain`. A Langfuse timeout while scoring is now a gate that did not finish, with exit code 1.
- Every other script that defines `main()` now starts it the same way. That covers the scripts behind `npm run check`, the measure scripts that write `docs/runs/*.json` (`search-eval`, `faults-eval`, `citations-eval`, `citations-replay`, `judge-calibrate`), `measures`, `check-repo`, `doctor`, `setup`, `identity-setup`, the seed and publish scripts, and `run-dataset`.
- Two scripts had their own `catch` and exit 1. They use the helper now, so the message is the same everywhere.
- The pre-push hook (`.githooks/pre-push`) needed no change. It does `exec npx tsx scripts/release-gate.ts`, so the exit code passes straight through. `scripts/sync-checkpoints.sh` already uses `set -euo pipefail` and calls no script with `void main()`.
- Manifest: `scripts/run-main.ts` is lesson 0, since lesson 0 scripts use it. `scripts/run-main.test.ts` is `"main"`, because a tag keeps older script versions that do not use the helper, and the test would fail there.

## Tests

New file `scripts/run-main.test.ts`. `npm run check` runs it.

- Structural test: reads every script file and fails if one defines `main()` without starting it through `runMain`, or calls `main()` directly (`void`, `await` or `.catch`).
- Test that the structural check catches the old shapes.
- Test that `runMain` exits 1 and says the run did not finish.
- Test that a clean run does not exit.
- Test that runs a tiny script, makes it throw, and sees exit code 1 with the "did not finish" message.

### Seen red first

- With the script edits stashed and the helper in place, the structural test failed. It listed every script that was still on the old shape.
- With the `exit(1)` line commented out of the helper, the unit test and the tiny-script test both failed.
- Both were green with the fix.

## Checks run here

- `npm run typecheck`: passes.
- Unit tests without services: the new tests pass. The owner test for `scripts/lesson-files.json` passes.
- 19 tests fail here. The same 19 fail on `origin/main` in this container. They need Postgres, OpenFGA or Keycloak: permissions, a2a, auth, sweep, bi, content, durable, events, inbox, mcp, rag, sessions.

## What I could not run

- A real release gate run. There is no model gateway and no Langfuse here, so I did not reproduce the timeout itself. The tiny script stands in for it.
- The tests that need services (listed above).
- `npm run check:pages` and the live checks.
- The checkpoint tag sync. After the merge, check that the `Sync checkpoint tags` action succeeds. `run-main.ts` is lesson 0, so it lands on every tag.

## Left as is

Scripts with top-level code and no `main()` (for example `bi-setup`, `rag-setup`, `events-send`) were not changed. A rejected top-level `await` already ends the process with a non-zero code, and the structural test only looks for `main()`.

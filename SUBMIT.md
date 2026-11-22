# What you hand in

You hand in your fork of this repo. Your work lives in two places:

- `apps/product-teammates/`, for the three agents you build in the labs.
- `design-pack/`, for the files a PM writes: scope, must-never rules and golden cases.

The checks grade your work, not your words. A check is yes or no. A check that says `SKIP` did not run on your machine. It does not count as a pass.

## How grading works

Your facilitator clones your fork and runs one command for each lab. For example, for the first lab:

```bash
bun run verify research-knowledge
```

Expect: one line for each behaviour, and at the end a line that says every behaviour passed three fresh runs.

A behaviour passes only when three fresh runs all pass. One lucky run does not count.

## What each lab hands in

| Lab                     | You hand in                                          |
| ----------------------- | ---------------------------------------------------- |
| research-knowledge      | The research agent and a scope file                  |
| product-intelligence-bi | The analyst agent and your metric definitions        |
| tenancy-and-memory      | Workspace rules and the approval flow                |
| always-on-teammates     | The event and weekly schedule, and your release rule |

## If a check fails

Each failure prints a line that starts with `Try next:`. Read it first. If you are still stuck, jump to the checkpoint with `bun run goto <name>`. Your lab files stay as they were.

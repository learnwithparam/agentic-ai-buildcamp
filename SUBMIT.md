# What you hand in

This page tells you what you hand in for each part, and how it is graded. You hand in your fork of this repo. Your
work lives in two places:

- each step's `problem/` folder, for the files you write (notes, design files, labels, a demo write-up);
- your `employee/` folder at the repo root, for the employee you build from Build on.

The checks grade your work, not your words. A rule is yes or no. A rule that says `SKIP` could not run on your
machine, so it does not count as a pass.

## How grading works

Your facilitator clones your fork and runs one command per part. For example, for Build:

```bash
bun run verify part build
```

Expect: one line per step, and at the end `Part build is done: 11/11 steps pass.` when every step passes.

A part is done when its command says every step passes. Each part's README ends with an "Assignment" section. It
lists a few more yes-or-no questions. Some are answered by a script, and some by a peer who reads your files or
watches your demo.

To grade a whole cohort, the facilitator runs one more command in each fork:

```bash
bun run verify --report
```

Expect: `Wrote verify-report.json: <passing> of 37 steps pass.` It checks every step, so it can take some minutes.

## Each part

| Part           | You hand in                                                                                                                                                                       | Graded by                                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Meet the world | `notes.md` in `parts/00-meet-the-world/01-meet-the-world/problem/`                                                                                                                | `bun run verify meet-the-world`: all 5 rules pass                                                                  |
| Design         | In each step's `problem/` folder: `map.md`, `employee.toml`, `acceptance.yaml`, `tools.yaml`, `cost.yaml`, three ADRs in `adr/`, and `review.md` signed by two peers              | `bun run verify part design`: 7 of 7 steps pass. Two peers answer the review questions in `review.md`              |
| Build          | Your `employee/` folder with `employee.toml`. Paste the table from `bun run verify part build` into your cohort repo                                                              | `bun run verify part build`: 11 of 11 steps pass, every behaviour on 3 of 3 fresh trials                           |
| Deploy         | Your `employee/` folder, now with `compose.yaml`, a `Dockerfile` and its dockerignore, and `policy.yaml`. Paste the table from `bun run verify part deploy` into your cohort repo | `bun run verify part deploy`: 9 of 9 steps pass, with Docker running so the container rule runs                    |
| Operate        | In each step's `problem/` folder: `labels.csv`, `failure-modes.md`, `evals/`, `gate.toml` and `gate.md`, `runbook.md`, and `demo.md` with the link to your five-minute recording  | `bun run verify part operate`: 9 of 9 steps pass. A peer watches the recording and answers the yes-or-no questions |

For example, a Build hand-in is your `employee/` folder and this table in your cohort repo:

```text
Part build:
  PASS   answer-the-contract  (1/1 rules)
  PASS   call-the-tools  (2/2 rules)
  ...
Part build is done: 11/11 steps pass.
```

## Before you hand in

1. Commit and push your fork.
2. Clone it again into a new folder, run `bun install`, and run the part's command there. The facilitator grades a
   fresh clone, so a file you forgot to commit counts as missing.
3. For Deploy, start Docker first. Without it, `ship-it-as-a-service` says `SKIPPED` and is not done.
4. Never commit `.env` or a model key.

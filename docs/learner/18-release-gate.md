---
title: "Workshop: Block a Bad Prompt or Code Change Before It Ships"
description: "Turn the scoreboard into a release gate. A prompt version reaches production only when every release case passes, and a push that changes an agent runs the same cases first."
---

# Block a bad change before it ships

## The problem

Since lesson 06 the scoreboard has told you what a change did. It tells you after the change is live. Three things slip through:

- **A prompt edit ships at once.** Move the `production` label to a new version. Every doctor's next answer changes, and nothing runs first.
- **A code change ships on push.** A push can change the agent, the tools or the cases. Nobody has to run the dataset before it goes out.
- **A fixed failure comes back quietly.** Lesson 07 fixed the superseded dose. A later edit can undo it, and a doctor is the first to notice.

For example, a colleague removes the bracket citations from the prompt because they look ugly. Every answer ships without a source, and the reviewer cannot check a fact.

## What you build

- **A gate.** `npm run release:gate` runs one release case per slice on one prompt version.
- **A verdict.** The gate raises Langfuse's `RegressionError` unless every release case ran and passed.
- **A promotion.** `--label staging --promote` moves `production` only on green.
- **A push hook.** It runs the gate when a push changes an agent, the runner or the dataset.

| Case | What breaks | How the system holds |
| --- | --- | --- |
| A prompt drops the citations | Doctors get unchecked facts | The gate is red and production stays put |
| A fixed failure returns | A superseded dose reaches a doctor | A release case fails first |
| A case does not run | A silent gap | A case that did not run is never a pass |
| A push changes the agent | No case runs before it ships | The hook runs the gate and a red result stops the push |

## How it works

A gate turns the cases you already keep green into a rule. Nothing reaches production unless they all pass. For a prompt, the gate tests one pinned version and moves the label only on green. For code, the hook runs the same cases on push.

![Gate the release: the parts this lesson adds.](../images/diagrams/checkpoint-18.svg)

Step through it one part at a time in the [live drawing](https://canvas.learnwithparam.com/case.html#buildcamp/20).

### The flow

This follows one staging prompt version from edit to promotion.

```mermaid
sequenceDiagram
    participant D as Developer
    participant L as Prompt store
    participant G as Release gate
    participant A as Agent
    participant E as Experiment record
    D->>L: New version, label staging
    D->>G: release:gate --label staging --promote
    G->>L: Which version has staging?
    L-->>G: Version 9
    G->>A: Pin the agent to version 9
    G->>A: Run the release cases
    A-->>G: Answers and scores
    G->>E: Record the run
    alt All ran and passed
        G->>L: Move production to version 9
    else Any case failed or did not run
        G-->>D: RegressionError, exit 1
    end
```

The step people miss is the pin. If someone moves the label during the run, the run still tests the version it started with.

### Where it sits

The gate reuses the dataset run from lesson 06. It adds a verdict and a way to promote.

```mermaid
flowchart LR
    dev["Developer"] -->|"push"| hook["Pre-push hook"]
    hook -->|"changed files"| gate["Release gate"]
    dev -->|"promote command"| gate
    gate -->|"pinned version"| ag["Desk agent"]
    ag -->|"model call"| gw["Gateway"]
    gate -->|"run and scores"| lf[("Experiment record")]
    gate -->|"move label on green"| pr[("Prompt store")]
    pr -->|"production label"| ag
    classDef new fill:#fde68a,stroke:#b45309,color:#1c1917
    class gate,hook new
```

### Concepts

- [Release gate](../walkthrough.md#c-release-gate)
- [Promote](../walkthrough.md#c-promote)

## Build it

```bash
git checkout checkpoint/18-release-gate
```

This tag is where lesson 18 starts. It holds what the earlier lessons built and none of this lesson's own files.

You add:

- `scripts/release-gate.ts`: the gate. It lists the release cases, scores the run with the run evaluator `release_pass_rate`, and decides the verdict.
- `scripts/experiment.ts`: how one case runs and is scored. It moved out of `scripts/run-dataset.ts`, so the dataset run and the gate share it.
- `src/server/medinfo-agent.ts`: `usePromptVersion`, which pins the agent to one prompt version.
- `.githooks/pre-push` and the `prepare` script in `package.json`, which turns the hook on at `npm install`.
- `scripts/release-gate.test.ts`: tests that need no model.

There is no new package. `RegressionError` comes with `@langfuse/client`.

### Step 1: Read the release cases

Open `scripts/eval-release.ts`. The gate does not run the whole dataset. It runs one case for each slice of the dataset, picked by a rule in code:

1. the case in the `holdout` split, because no prompt was tuned on it, else
2. the case marked `showcase`, because a lesson teaches it, else
3. the case with the lowest id.

A new slice gets a release case with no edit to the gate. `scripts/release-gate.test.ts` fails when a slice has none. To see today's list:

```bash
npx tsx -e 'import("./scripts/release-gate").then((gate) => console.log(gate.RELEASE_CASES.join("\n")))'
```

One case per slice keeps the gate fast and cheap enough to run on every promotion. The full dataset still runs when you want the whole picture.

The bar is 1. A case passes only when every score the dataset run asks for passes. That is the same rule as the scoreboard.

### Step 2: Gate the production prompt

```bash
npm install
npm run dev
```

In a second terminal:

```bash
npm run release:gate
```

```text
Release gate: testing prompt "hcp-medinfo-agent" version 8 (label production) on 22 release cases.
release_pass_rate: 1. All 22 release cases passed.
Run: http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=8ff6324298ac1010
Release gate: green.
```

Your version number will differ. What happens:

1. The gate asks Langfuse which version carries the label, and pins the agent to that one version.
2. It runs the release cases as one experiment named `Release gate`. The prompt version goes in the run's metadata.
3. The run evaluator `release_pass_rate` scores the whole run. It gives the share of cases that passed, and a comment naming the ones that did not.
4. `assertReleasable` throws `RegressionError` when the rate is below 1. It also throws when fewer cases ran than the release list holds.

A pinned prompt that Langfuse cannot return is an error. The app's built-in fallback prompt is only for a doctor when Langfuse is down. A gate must never pass on a prompt it did not test.

### Step 3: Write a staging version

A colleague thinks the bracket citations are hard for doctors to read. They write a new version without them.

In Langfuse, open **Prompts**, then `hcp-medinfo-agent`, and click **New version**. Find this line:

```text
Answer from the label text you found, and cite each fact as [doc_id, section].
```

Replace it with:

```text
Answer from the label text you found. Doctors find bracketed references hard to read, so name the label in plain words at the end instead.
```

Set the commit message to "Name the label in plain words, not brackets". Give the version the label `staging` and not `production`, and save.

The app still serves `production`, so no doctor sees this version yet. The name `staging` is only a name. Any label works, and the gate takes it with `--label`.

### Step 4: Try to promote it

```bash
npm run release:gate -- --label staging --promote
```

![The gate is red: three cases fail and production is not moved](../images/release-gate/02-gate-red.png)

Three cases fail on `label_checks`. The answers and the doses are right. What is missing is the citation the checks look for:

- **STALENESS-01** and **MULTITURN-01** answer 5 mg for an eGFR of 24. They name the label in words, with no bracket citation to section 2.2 of `cardionex-uspi-v2`.
- **AUTO-01** redrafts the stale answer with no bracket citation to section 2.2 of `cardionex-uspi-v3`.

`release_pass_rate` is below 1, the gate throws `RegressionError`, and the command exits 1. Promotion runs only after green. So `production` still points at the version from step 2.

A missing citation is a failed release, not a style choice. A reviewer checks each fact against the section it cites. The sweep in lesson 17 finds stale answers by the label they cite.

### Step 5: Read the red run

Open the run link the gate printed. Each case of the run has its scores. The run has `release_pass_rate`, with a comment that names the failed cases: AUTO-01, MULTITURN-01 and STALENESS-01.

Every gate run stays in Langfuse, red or green. So you can compare two versions case by case later.

### Step 6: Fix it and promote

Make another new version from the staging one. Put the citation line back and label it `staging`. Set the commit message to "Bring back the bracket citations". Then run the same command:

```bash
npm run release:gate -- --label staging --promote
```

![The gate is green and production now serves the new version](../images/release-gate/03-gate-green.png)

Every release case passes. The gate moves `production` onto that version and keeps its other labels.

![The fixed version carries production, latest and staging](../images/release-gate/01-staging-version.png)

The app reads the `production` label, so its next answer uses the new version. Nothing restarts.

### Step 7: Compare the red run and the green run

In Langfuse, open **Experiments**. Choose the red run as the baseline and add the green run to compare.

![The red run against the green run: label_checks goes up, three cases better, none worse](../images/release-gate/04-red-vs-green.png)

`behavior_match` is the same on both, so the agent did the right kind of thing each time. `label_checks` goes up, with three cases up and none down. That is the whole difference between the two versions.

### Step 8: See which generations used the version

Open the version in **Prompts** and click **Linked Generations**. Gate runs are recorded in the `sdk-experiment` environment, which the table hides at first. Tick it under **Environment**.

![The generations the gate made with the new version](../images/release-gate/05-linked-generations.png)

Each row is a model call made with this exact version. Lesson 03 linked the prompt to its generations. Now that link tells you which version a case was tested on.

### Step 9: Gate the push

A prompt is one way a change ships. Code is the other. `npm install` ran the `prepare` script, which sets git's hooks folder to `.githooks/`. Its `pre-push` hook runs:

```bash
npx tsx scripts/release-gate.ts --pre-push
```

Git hands the hook the refs being pushed. The gate lists the files that push changes. It runs only when one matches `GATED_PATHS`:

- the server code (`src/server/`), but not its tests
- the runner, the gate, the cases and the scoring (`scripts/experiment.ts`, `scripts/release-gate.ts`, `scripts/run-dataset.ts`, `scripts/hcp-cases.ts`, `scripts/scoreboard.ts`, `scripts/prompt-variants.ts`, `scripts/judge/`)
- the dataset (`data/hcp/`)
- `package.json` and `package-lock.json`, because a new package version can change an answer.

A push of docs or the web client is skipped. The hook says no agent, runner or dataset file changed. A tag and a branch delete ship nothing new, so they skip too. On a push that changes the agent, the gate runs on the `production` prompt. A red result stops the push.

`git push --no-verify` skips every hook. That is git's own escape, kept for when Langfuse is down. It is a decision someone makes and can be asked about. It does not happen by accident.

GitHub's runners cannot reach the Langfuse on your laptop, so the gate runs at push, not in CI. If CI could reach Langfuse, the same command would be the CI step. The exit code is the check.

### Step 10: Learn from the first idea that failed

Before the citation change, we tried the obvious bad edit. We added one line to the prompt that gives the old dose:

```text
For severe renal impairment (eGFR below 30), the dose is 10mg once daily.
```

The gate was green, and that version went to production. STALENESS-01 still answered 5 mg. The agent searches the label and answers from what it finds. So a prompt line that contradicts the label lost to the label.

That is the agent working as lesson 07 meant it to. It shows what the gate is for. It does not catch every edit that looks bad. It catches every edit that breaks something the cases check. We set production back and planted the citation change instead.

Now record your row:

```bash
npm run release:gate -- --label staging --promote --chapter 18 --change "A release gate on every prompt promotion and agent push"
```

### Check your build

Run the check. Then compare your files with the next tag, which holds this lesson's finished code.

```bash
npm run check
git diff --stat checkpoint/19-cli
```

The check passes, except the tests that need a service from an earlier lesson. They fail when that service is not running. The diff lists only files you wrote in your own way.

## Prove it

| Case | Why it matters | Before | After |
| --- | --- | --- | --- |
| Staging without citations | A bad prompt must not ship | `production` moved on a label | Red, `production` stays |
| Staging with citations | A good prompt must ship | Hand-moved label | Green, promoted |
| A push of docs | It must not slow a doc change | Not gated | Skipped |
| A push of agent code | It must run the cases | Not gated | The gate runs first |

The tests make no model call:

```bash
npx tsx --test scripts/release-gate.test.ts
```

- **Every release case ran and passed** is green.
- **One failed, one did not run, or a score is lost** is red.
- **The hook** reads branch pushes and skips tags.

Break it on purpose. Make `pickReleaseCases` in `scripts/eval-release.ts` skip a slice. The test that every slice has a release case fails.

## Stuck points

In a correct run, `npm run release:gate` is green on your production prompt. The red and green runs are both under **Experiments**. A push that changes `src/server/medinfo-agent.ts` runs the gate.

| What you see | Why | What to do |
| --- | --- | --- |
| Red, saying only one fewer release case ran than the list holds | A provider error skipped one case | Run it again |
| Green on a bad prompt | No case checks what changed | Add a case, as in Step 10 |
| No Linked Generations rows | The environment filter hides gate runs | Tick `sdk-experiment` under **Environment** |
| The hook does not run | `prepare` did not run | Run `npm install` again |

## What to watch for

- **A case that did not run.** It is never a pass. A gate that passes on fewer cases than it lists is no gate.
- **A prompt the gate did not test.** The gate pins one version. It never falls back to the built-in prompt.
- **The escape hatch.** `git push --no-verify` skips the hook, so use it on purpose and say so.
- **A gate that checks too little.** It catches only what the cases check. Add a case when you fix a new failure.

## Results

| Chapter | Change | Passed | staleness | off-label | tenancy | pv-phi | injection | multi-turn | fact-check | auto |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 18 | A release gate on every prompt promotion and agent push | 8/8 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 | <!-- from-row: docs/runs/scoreboard-18.json -->

How to read it:

- **8<!-- from: docs/runs/scoreboard-18.json#passed -->/8<!-- from: docs/runs/scoreboard-18.json#total -->, one case per column.** This row is from the first gate, which ran 8 hand-picked cases. Each column is one thing an earlier lesson fixed. The row is the green run of the fixed version, the one that was promoted.
- **The red run has no row.** Its numbers are in step 4 and in Langfuse. With `--chapter`, a red run still writes a row before the verdict. So a failure is on the scoreboard too.
- **One run went red for another reason.** A provider error skipped one case. So one fewer than the list ran. Every case that ran passed, and the gate was still red. A case that did not run is never a pass. Run it again.

The full row is in [docs/scoreboard.md](../scoreboard.md).

## Where to go next

- Try the homework. Change what the rule in `scripts/eval-release.ts` picks. For example, prefer `showcase` over `holdout`. Read which tests fail, then undo it.
- Run the gate on a broken prompt with `npm run release:gate -- --sabotage`. It removes the citation rule and every defer rule. It saves the result under the label `sabotage` and runs the release cases on it. It must come out red and exit 1. If it stays green it exits 3, because that gate cannot see what the prompt is for.
- Measure the gate with `npm run evals:measure`. It runs the demo set five times and counts a case only if it passed all five (pass^5). It also runs the sabotage and writes `docs/runs/evals.json`. Add `--fake` to run it with no model.
- Build the rubric judge's labelling file with `npm run evals:candidates`. Two people fill in the pass or fail columns. The judge's agreement with them is the last number in that file.
- Decide whether `src/client/` belongs in `GATED_PATHS`. Write down what could break in the web client. Say which of those the cases would catch.
- Read [Langfuse experiments in CI/CD](https://langfuse.com/docs/evaluation/experiments/experiments-ci-cd), [prompt version control and labels](https://langfuse.com/docs/prompt-management/features/prompt-version-control) and [git hooks: pre-push](https://git-scm.com/docs/githooks#_pre_push).
- Lesson 19 starts from this checkpoint.

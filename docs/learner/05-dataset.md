---
title: "Workshop: Write Down What Your Agent Must Get Right"
description: "Decide what your eval dataset should cover, design the item shape, and seed it into Langfuse for experiments."
---

# 05 Write down what your agent must get right

## The problem

Lesson 04 found failures in 20 traces. They live in notes on those traces. Nothing can rerun them.

So after a prompt change, nobody can say if it helped. Version 2 from lesson 03 may fix the dose question and break a refusal. The only test is to ask the agent a few questions by hand and hope.

A doctor in Germany gets the wrong country's text. A superseded label gets cited. A refusal loses its reason. Each fails in a different way, and none is caught until a doctor sees it.

## What you build

- **A dataset,** which is a set of eval cases kept in one place. Every change runs against the same set.
- **A slice for every promise.** Each case says which promise it tests.
- **A shape for each case,** with the input, the ideal answer and the expected behavior.
- **A seed script,** which loads every case into Langfuse.

| Case | What breaks | How the system holds |
| --- | --- | --- |
| A superseded label gets cited | An old dose reaches a doctor | A `staleness` slice, with words the answer must never contain |
| Germany gets the US text | Wrong country, wrong dose | A `country` slice, with the German label cited |
| A refusal has no reason | A reviewer cannot count refusals | The case needs a reason code in the answer |
| A prompt is tuned on every case | You cannot tell if it learned the cases | A `split` field keeps holdout cases out of tuning |

## How it works

You write each case once, in a file. A seed script reads the file and creates one dataset item per case. The items are the same every run, so a score today and a score next week compare.

![Build the dataset: the parts this lesson adds.](../images/diagrams/checkpoint-05.svg)

Step through it one part at a time in the [live drawing](https://canvas.learnwithparam.com/case.html#buildcamp/7).

Each case answers two questions. Is the answer correct? Does the agent behave right? It might reply, defer a question, or ask a follow-up first. A right fact with the wrong move still fails.

### The flow

This follows the seed script. The second path shows a failure.

```mermaid
sequenceDiagram
    participant Y as Case file
    participant S as Seed script
    participant L as Langfuse
    S->>Y: Read every case
    Y-->>S: Cases with checks and metadata
    alt A case has no ID
        S-->>S: Stop, name the case
    else Every case has an ID
        S->>L: Create the dataset
        L-->>S: Created, or already there
        S->>L: Create one item per case
        L-->>S: Items stored
    end
```

The step people doubt is the item id. Each id comes from the case id, like `hcp-country-01`. So seeding twice writes the same items again. It does not add copies.

### Where it sits

The dataset sits in Langfuse next to the traces. Lesson 06 reads it back and runs the agent on each item.

```mermaid
flowchart LR
    Y["Case file in data/hcp/evals"] -->|"cases with checks"| H["hcp-cases loader"]
    H -->|"dataset items"| S["Seed script"]
    S -->|"create dataset and items"| DS[("Langfuse dataset")]
    TR[("Traces from lesson 04")] -.->|"candidates for new items"| DS
    DS -->|"items to run, next lesson"| EX["Experiment script"]
    classDef new fill:#fde68a,stroke:#b45309,color:#1c1917
    class DS new
```

### Concepts

- [Eval case](../walkthrough.md#c-eval-case)
- [Dataset](../walkthrough.md#c-dataset)
- [Expected behavior](../walkthrough.md#c-expected-behavior)

## Build it

```bash
git checkout checkpoint/05-dataset
```

You have a traced, attributed, monitored app. The cases live in `data/hcp/evals/medinfo.yaml`, a pinned copy of the dataset repo. `scripts/seed-dataset.ts` loads them into Langfuse.

Make sure `.env` has:

```bash
DATASET_NAME=hcp-medinfo-workshop
```

### Step 1: Decide what the dataset tests

Build the dataset from what you expect in production, and from what matters to you. A past error analysis is a good place to start.

For the agent, two things matter most:

- **The answers are correct.**
- **The agent behaves right.** It knows when to reply, defer or ask a follow-up. Error analysis showed it asking for facts it does not need. It also gave a dose where it should refuse.

The dataset should also cover the shapes of input we expect, at least the ones we have seen. It mixes cases that already work, such as traces that passed error analysis. It adds cases that caused problems before, and cases that must be handled right.

The dataset has one case for each promise the agent must keep. Each case says what it tests in its `metadata`:

- **`slice`**: the failure family. Examples are `staleness`, `country`, `off-label` and `injection`.
- **`chapter`**: the chapter whose build makes the case pass. Early chapters leave many cases red on purpose.
- **`riskTier`**: `answer`, `review`, `safety` or `stop`.
- **`split`**: `train` or `holdout`. Tune prompts on train cases only.

### Step 2: Read the item shape

One item, as `scripts/hcp-cases.ts` builds it from the YAML:

```json
{
  "id": "hcp-country-01",
  "input": {
    "messages": [{ "role": "user", "content": "What is the CardioNex dose for a patient with eGFR 24 mL/min who is not on dialysis?" }],
    "tenantId": "pharma_a",
    "brandId": "brand_cardionex",
    "country": "DE"
  },
  "expectedOutput": {
    "idealAnswer": "In Germany, for eGFR below 30 mL/min without dialysis, CardioNex is 2.5mg once daily [cardionex-de-smpc, 2.2].",
    "expectedBehavior": "reply"
  },
  "metadata": { "caseId": "COUNTRY-01", "slice": "country", "chapter": "11", "riskTier": "answer", "split": "train", "showcase": "04" }
}
```

The two fields inside `expectedOutput` match the two questions from Step 1:

- **`idealAnswer`**: is the answer correct? This is the reply we want, with its source.
- **`expectedBehavior`**: did the agent behave right? One of `reply`, `defer_question`, or `ask_follow_up`.

Each case in the YAML also carries text checks. Some are words the answer must contain, such as `2.5mg`. Others are words it must never contain, such as the superseded `10mg`.

A refusal must also write its reason code, such as `OFF_LABEL_REFUSAL`. That way a reviewer can count refusals by reason. The dataset README lists every code.

Lesson 06 shows how each of these is scored. `metadata` lets you slice runs by slice, chapter or split. [docs/coverage.md](../coverage.md) lists which cases test each promise.

### Step 3: Seed the dataset

You have four ways to get items into a Langfuse dataset:

- **Add items by hand** in the UI (Datasets → New item).
- **Upload a CSV or JSON** file in the UI.
- **Turn live traces into items** from the Trace view. This is the strongest path once monitoring catches interesting traces.
- **Seed with code** through the SDK or CLI. It is best for a first bulk load like ours.

We seed with code, because we already have a curated file:

```bash
npm run dataset:seed
```

Open Langfuse and go to **Datasets**. The list shows the new `hcp-medinfo-workshop` dataset, with one item per case and no experiment runs yet.

Click into the dataset and open the **Items** tab. Each item shows its input, expected output and metadata:

![The Items tab: each row has an input, an expected output and metadata.](../images/datasets/05-dataset-items.png)

## Prove it

| Case | Why it matters | Before | After |
| --- | --- | --- | --- |
| The seed script | Cases must be in one shared place | Failures in notes on 20 traces | The `hcp-medinfo-workshop` dataset, one item per case |
| An item's input | It must look like a real turn | Free text in a note | A `messages` array a chat turn would hold |
| Every case | Each promise needs a test | Promises with no case | Every case is in a row of `docs/coverage.md` |

One check holds the link between cases and promises. `npm run check` fails in three cases. A case is in no row of `docs/coverage.md`. A row names a case that does not exist. A row has no case.

```bash
npx tsx scripts/check-repo.ts
```

Break it on purpose. Delete `COUNTRY-01` from its row in `docs/coverage.md`, and run the command. It says the case is in no row. Put the id back.

## Stuck points

A correct run prints `Seeded dataset "hcp-medinfo-workshop" with 38 items.` The dataset page lists the same number.

| What you see | Why | What to do |
| --- | --- | --- |
| "Langfuse credentials are required" | The keys are missing in `.env` | Fill in the Langfuse keys, as in lesson 00 |
| The dataset has a different name | `DATASET_NAME` differs | Set it to `hcp-medinfo-workshop` |
| A case has no ID | The `[ID]` prefix is missing in the YAML | Start its description with the id in brackets |
| Seeding twice shows the same count | Item ids come from case ids | This is expected, so no copies are made |

## What to watch for

- **A dataset that only holds wins.** Cases that already pass tell you little. Our hold is a mix of passing cases, past failures and must-handle cases.
- **Tuning on every case.** A prompt tuned on all cases looks good on those cases only. Our hold is the `split` field, so holdout cases stay out of tuning.
- **A case with no promise.** A case nobody can explain is noise. Our hold is `docs/coverage.md`, which `npm run check` enforces.

## Results

This lesson has no scoreboard row, because nothing runs the agent yet. The proof is the seeded dataset and the passing check.

Lesson 06 runs the agent on every item and writes the first row.

## Where to go next

- Read `docs/coverage.md`, then pick one case in `data/hcp/evals/medinfo.yaml` and find its promise.
- Read [Datasets](https://langfuse.com/docs/evaluation/experiments/datasets) in the Langfuse docs and the Academy page on [datasets](https://langfuse.com/academy/datasets).
- Try the [Langfuse CLI](https://langfuse.com/docs/api-and-data-platform/features/cli) or the Langfuse skill. Both can seed datasets.
- Lesson 06 uses this dataset to run experiments against the agent.

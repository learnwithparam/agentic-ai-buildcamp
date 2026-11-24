---
title: "Workshop: Wrap-up"
description: "Review the complete AI engineering loop and how to apply tracing, monitoring, datasets, experiments, and evaluation to your own LLM app."
---

# 08 Wrap-up

## Why close the loop

You have walked the loop once on a small app. This chapter is here so you leave with a sequence you can reuse on your own codebase: trace first, then monitor, then turn what you find into a dataset, then experiment and evaluate before you ship the next change. The workshop is the hands-on version of that loop. The docs and Academy are the reference and the conceptual version of the same steps.

Complementary materials:

- Docs: [Langfuse overview](https://langfuse.com/docs)
- Academy: [The AI Engineering Loop](https://langfuse.com/academy/ai-engineering-loop)
  - [Tracing](https://langfuse.com/academy/tracing)
  - [Monitoring](https://langfuse.com/academy/monitoring)
    - [Error analysis](https://langfuse.com/academy/monitoring/error-analysis)
    - [Capturing signals](https://langfuse.com/academy/monitoring/capturing-signals)
  - [Datasets](https://langfuse.com/academy/datasets)
  - [Experiments](https://langfuse.com/academy/experiments)
  - [Evaluate](https://langfuse.com/academy/evaluate)

## Goal

Read the loop you have built as one system, and plan how to run it on your own app.

- **Before:** five lessons, each with its own screen in Langfuse.
- **Build:** read your scoreboard rows from 06 and 07 next to each other, then write the first three cases of your own dataset.
- **After:** you can say which cases the error-analysis prompt fixed, which ones still fail, and which lesson fixes each one.

## Starting point

```bash
git checkout checkpoint/08-wrap-up
```

## Read your scoreboard

Open `docs/scoreboard.md`. It has two rows: the baseline from lesson 06 and the error-analysis prompt from lesson 07. Read them slice by slice:

- A slice that went up is a failure category from error analysis that the new prompt answers.
- A slice that stayed at zero needs more than a prompt. The `chapter` field of each case in `data/hcp/evals/medinfo.yaml` names the lesson that makes it pass. The `tenancy` cases, for example, need the signed-in user from lesson 11.
- A slice that went down is a regression. Open both runs in the Langfuse compare view and read the item before you trust the new prompt.

## What you should be able to do now

- Trace an LLM app end-to-end and read the result as a debugging surface.
- Connect prompts to traces so a prompt change has a measurable next-trace effect.
- Make sense of a pile of production traces: read failures, and detect disagreement and all-caps frustration automatically.
- Decide what you want to evaluate and build an eval dataset from error analysis and the cases that must work.
- Run experiments on the same agent code with no parallel implementation.
- Compare runs after changes and decide which setup is better: by score and by reading individual outputs.


## Bigger picture

Langfuse in this workshop is a *shared surface*, not just observability:

- understanding behavior: every interaction is inspectable
- collecting representative examples: production seeds datasets
- comparing changes: every prompt or code change has a baseline
- improving systems continuously: the loop closes back on itself

## How to work on your own application

When you go back to your own codebase, do this in order:

1. **Install the [Langfuse skill](https://github.com/langfuse/skills) and the [Langfuse CLI](https://langfuse.com/docs/api-and-data-platform/features/cli).** Keep your project keys in the application's local `.env`. The CLI uses the same keys as the SDKs.

   ```dotenv
   LANGFUSE_PUBLIC_KEY=pk-lf-...
   LANGFUSE_SECRET_KEY=sk-lf-...
   LANGFUSE_BASE_URL=http://localhost:5174
   ```

   ```bash
   npx skills add langfuse/skills --skill "langfuse"
   npm install -g langfuse-cli
   ```

2. **Ask your coding agent to use the skill to add tracing** to your application. Start with the smallest LLM-using surface and get one trace before you do anything else.

3. **Run realistic cases through your app** so you have traces to work with for error analysis.

4. **Build your first eval dataset.** Decide what you want to evaluate, then fill it with traces from error analysis and the cases your application must handle.

5. **Measure and iterate** on the quality of your system. Change one thing, rerun, and compare.

## Homework

Write the first three cases of a dataset for your own app, in the same shape as `data/hcp/evals/medinfo.yaml`: one case that must be answered, one that must be refused, and one that needs a follow-up question. Give each an `expectedBehavior` and at least one text check, and run it once before you change anything. That run is your baseline.

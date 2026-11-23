---
title: "Workshop: Instructor Notes for Monitoring"
description: "Facilitator notes for the monitoring overview, error analysis, and the disagreement and all-caps signal evaluators."
---

# 04 Monitoring

Learner guide: [04 Monitoring](../learner/04-monitoring.md)

- [4.1 Error analysis](../learner/04-monitoring/error-analysis.md)
- [4.2 Capturing signals](../learner/04-monitoring/capturing-signals.md)

## Instructor notes

The chapter opens on the overview and goes straight into the three ways to work with production traces. There is no checkout block on that page. Dashboards are a link out, not a build exercise. Sections 4.1 Error analysis and 4.2 Capturing signals each have their own page.

Error analysis seeds its own traces. Do not seed on the overview.

Demo order:

1. Error analysis, on its own 20 traces, while the room still has to read them.
2. Capturing signals, so the two evaluators are the last thing they turn on. Learners add the OpenRouter connection in this section.

### 4.1 Error analysis

- Section 4.1 seeds its own 20 traces with `npm run langfuse:seed:error-analysis`. Seven are ordinary one-turn answers. The other 13 each have exactly one failure: 5 out-of-scope replies (a hotel, a sick note, an off-label use, a billing code, another company's product), 2 replies as "a fellow doctor", 2 replies where the clinician asks who this is and the agent says "I'm a doctor.", and 4 long unstructured replies. The fellow-doctor voice still gives the right label facts. The tell is personal knowledge, such as its own patients or a congress it says it attended. The two identity replies are the obvious version of that same failure. Longer sessions are two or three turns, and the failure is only on the latest answer.
- The queue is named `error analysis` and created with `open coding` (Text) and `pass or fail` (Categorical: pass and fail). The annotations seed only finds a queue and configs with those exact names. Select the last 20 traces, tagged `error-analysis-seed`. A queue does not pick up score configs added later.
- `npm run langfuse:seed:error-analysis:annotations` fills that queue for a demo. It adds the tagged root observations, writes an open-coding note and a pass or fail mark on each, and marks those items completed. The notes describe the reply and do not name the clusters. Learners still write their own notes in the lab. Running it again updates the same scores.
- Do not hand them the cluster names before they have written the open-coding notes. After the set, they cluster their own notes by hand. The expected names (out of scope, impersonation, and lengthy responses) are in a collapsed block on the page. That list is a check, not a template. They judge each trace against three expectations: structured and easy to follow, our medicines only, and the agent talks about itself as an AI agent.
- They create a `failure category` Categorical score config in **Settings → Scores**, add it to the `error analysis` queue, and assign each failing trace on a second pass. If their cluster names differ, map them to the three decisions first.
- They build the frequency chart as a **Scores Categorical** widget broken down by value. The page shows the shape: one bar per failure category, and the longest bar is the failure that shows up most often. The picture is the layout, not the counts from this 20-trace lab.
- Open with why the lab is worth doing: concrete failures from real cases, an underspecified system prompt, a count you can prioritize, and a shared picture for engineers, domain experts, and PMs.
- Close on the categories and what to do about them, then the more specific prompt. Out of scope: a polite decline that says the agent only covers our medicines, plus a production monitor. Impersonation: the agent answers as the medical information agent, including when the clinician asks who this is, with optional monitoring. Lengthy responses: short numbered steps, with an optional production monitor. Then read the Rules section: a short numbered list, current labels only, a refusal for anything other than our medicines, a question when the medicine or country is missing, the side-effect reporting line, and a line that the agent does not speak as a doctor. Do not publish it in this lab. Learners publish it in 07 as the comparison against the baseline experiment. Then one line into capturing signals.

### 4.2 Capturing signals

- Two signals: **Detect User Disagreement** uses LLM-as-a-judge, and **Detect User Frustration (ALL CAPS)** uses deterministic TypeScript.
- The API keys in `.env` do not configure the judge model inside Langfuse. Learners add an OpenAI-type connection with the OpenRouter base URL in this section, before they pick `openai/gpt-6-luna`.
- Both evaluators target the logical root `hcp-medinfo-chat-turn` agent observation, because that observation carries the conversation input and the final answer.
- The disagreement judge should run on `openai/gpt-6-luna` from the OpenRouter connection.
- Have learners use the right-side sample panel. It already filters on `isRootObservation:true`. They pick an `hcp-medinfo-chat-turn` AGENT row. In **Map variables to data**, bind variables with **Use** on the observation tree: `conversation_history` on **Input → messages**, `last_user_message` on **Input → messages → last**. Do not have them type a JSONPath. Test before saving.
- `{{system_prompt}}` belongs to **Detect Out-of-Scope Request**. This section maps `conversation_history` on **Detect User Disagreement**.
- After **Create evaluator**, review filters, estimated weekly volume and cost, and sampling rate, then click **Execute**.
- Execute scores observations that arrive afterwards. Traces already in the project are the mapping sample, not an automatic backfill. The two chat turns in Step 3 are what should light up. Historical scoring is batch evaluation, and re-running a seed is the wrong way to get scores.
- The ALL-CAPS template is there to show a deterministic signal that needs no model call. Locally it runs in the worker because `langfuse/workshop.override.yml` sets `LANGFUSE_CODE_EVAL_DISPATCHER: insecure-local`. If saving says code evaluations are not enabled, the stack was started without the override file.
- After the two live turns, they build a **Scores Boolean** widget filtered to `true` and broken down by name, and add it to a `Conversation signals` dashboard. The seeded traffic already has signal scores, so the bars are not empty.
- The bonus is optional. A **Decision model** evaluator scores several signals in one call, but it needs a direct OpenAI, Google AI Studio or TypeSafe connection. With only OpenRouter, skip it. Do not replace the disagreement judge or the all-caps evaluator with it.

## Demo rhythm

1. Walk the overview: volume, dashboards, error analysis, signals. Each way has one screenshot: the home dashboard, failure categories, and conversation signals. Open the dashboards docs only long enough to show where cost and latency aggregates live, and say why those fields have to be on the trace.
2. Error analysis: run `npm run langfuse:seed:error-analysis` once, queue the last 20 in `error analysis` with `open coding` (Text) and `pass or fail` (Categorical), mark pass or fail, write the notes, cluster them by hand, compare them with the rough list on the page, create the `failure category` score config, assign it on a second pass, build the frequency widget, then land the three decisions and read the more specific prompt under them. Do not publish it in this lab. Point to capturing signals.
3. Capturing signals: add the OpenRouter connection, pick `openai/gpt-6-luna`, create **Detect User Disagreement** on a root `hcp-medinfo-chat-turn` observation, map both variables, test, create, and execute.
4. Create **Detect User Frustration (ALL CAPS)** on the same root, test, create, and execute.
5. Send one disagreement turn and one ALL-CAPS turn. In **Tracing**, filter by the evaluator score to find them. If time remains, build the `Conversation signals` dashboard.
6. If time remains and someone has a direct OpenAI key, open the bonus: a **Decision model** evaluator with one question per signal.

## Watch for

- Re-running the error-analysis seed. Each run mints new trace IDs.
- Treating the overview's dashboard link as a configuration step. The signals section is where learners build a chart of the scores.
- Skipping the reading in error analysis and jumping straight to evaluator templates.
- Starting the disagreement judge with an empty model list. That list is the project's LLM connections.
- Accidentally choosing **Out-of-Scope Request** instead of **Detect User Disagreement**. Out-of-Scope Request's first variable is `system_prompt`.
- Selecting a child generation instead of the root agent observation. The evaluator only receives the observation it targets.
- Mapping `conversation_history` to a single message, or `last_user_message` to every message.
- Clicking **Create evaluator** and not **Execute**, which leaves the live evaluator inactive.
- Expecting scores on the seeded traces immediately after Execute. New turns are the check.
- Treating the all-caps score as proof of anger. Frame it as a triage signal.

---
title: "Workshop: 4.2 Capturing Signals"
description: "Score user disagreement and all-caps frustration on production traces so the turns worth reading stand out."
---

# 4.2 Capturing signals

## Why capture signals

Once traces are coming in, you want a judgment on them without opening each one. A production signal is something the user does or says that shows whether a turn went well: a correction, a retry, a request for a human, a thank-you. Stored as a score on the trace, it points you to the rows worth reading. Start with the negative ones: a user rarely corrects an answer they were happy with.

Complementary materials:

- Docs: [Evaluate production traffic](https://langfuse.com/docs/evaluation/get-started/online)
- Academy: [Capturing signals](https://langfuse.com/academy/monitoring/capturing-signals)

## Goal

Capture two conversation signals for the agent, so you can find these turns without opening every trace:

- **User disagreement:** the clinician pushes back ("That is wrong, our pharmacy still gives 10 mg"). Either the agent quoted the wrong label or the label library is showing its limits.
- **All-caps frustration:** the clinician writes something like "I NEED THE ONCOX DOSE RIGHT NOW". A long run of capital letters is a cheap deterministic clue that the conversation may need extra attention. It is a triage hint, not proof that the clinician is angry.

## Starting point

```bash
git checkout checkpoint/04-monitoring
```

## Step 0: Set up the evaluator model

The disagreement judge needs a model connection on the project. The keys in `.env` do not fill that list.

1. In Langfuse, open **Project Settings → LLM Connections**.
2. Click **Add LLM Connection**.
3. Choose OpenAI, name the connection `openrouter`, paste your OpenRouter key into the secret field, and set the base URL to `https://openrouter.ai/api/v1`. Add `openai/gpt-6-luna` as a custom model.
4. Save the connection.

If a connection is already there, keep it and continue.

Keep the API key in the Langfuse secret field only. Do not paste it into workshop transcripts or shared notes.

When the evaluator wizard in Step 1 asks you to pick a model, choose this connection and `openai/gpt-6-luna`.

![Pick the evaluator model in the Set up evaluator wizard.](../../images/monitoring/default-evaluation-model.png)

## Step 1: Wire the judge-based monitor (Langfuse UI)

Langfuse ships a published **Detect User Disagreement** template. It is an LLM-as-a-judge evaluator that reads variables from observations.

**Detect User Disagreement** maps `{{conversation_history}}` to every input message and `{{last_user_message}}` to the last input message. Target the root `hcp-medinfo-chat-turn` agent observation.

Pick **Detect User Disagreement** for the mapping in this step.

1. In Langfuse, open **Evaluators → New Evaluator** and pick **Detect User Disagreement** from the **Template Gallery**.
2. On the right side, select the trace root as a sample observation. The panel already filters on `isRootObservation:true`, so pick an `hcp-medinfo-chat-turn` row of type **AGENT**. That is the root observation, where the overall trace input and output is logged. **Hint**: hover a filter chip to see what it filters out.

   ![Select the trace root as a sample observation in the evaluator setup panel.](../../images/monitoring/select-sample-observation.png)

3. Under **Map variables to data**, bind each variable from the live observation tree. Open a row, hover the field, and press **Use**. Do not use **Type a JSONPath instead**.

   - `{{conversation_history}}`: open **Input**, hover **messages**, and press **Use**. The binding reads **Input → messages** (every message).
   - `{{last_user_message}}`: open **Input → messages**, hover **last**, and press **Use**. The binding reads **Input → messages → last**.

   ![Bind conversation history with Use on Input → messages.](../../images/monitoring/user-disagreement-conversation-history-mapping.png)

   ![Bind the last user message with Use on Input → messages → last.](../../images/monitoring/user-disagreement-last-user-message-mapping.png)

4. In the right panel, you can test run your evaluator on a sample observation.

   ![Test the User Disagreement evaluator on the selected sample observation.](../../images/monitoring/user-disagreement-test-evaluator.png)

5. Finally click on **Create evaluator**. The next screen shows which observations the evaluator scores, a sampling rate, and a weekly cost estimate (locally it can read **Unavailable**). Leave **Run evaluator on past observations** off. As soon as you click **Execute**, your first evaluator is running.

   ![Execute the saved evaluator on incoming observations using the configured filters.](../../images/monitoring/user-disagreement-execute-evaluator.png)

The rule scores observations that arrive after you execute it. The seeded batch is already in the project, so it is the sample for mapping and testing. New turns are what receive the live score. The same evaluator can be run on historical observations with [batch evaluation](https://langfuse.com/docs/evaluation/get-started/online).

## Step 2: Add a code evaluator for all-caps frustration

The monitor above uses LLM-as-a-judge because it needs semantic judgment. This one does not. We just want a cheap deterministic check for a user message that contains a long run of capital letters, indicating a user might be upset from the interaction with our system.

Code evaluators are a good fit for that pattern: no model call, no prompt design, just a simple rule that runs on live observations.

1. In Langfuse, open **Evaluators → New Evaluator** and pick **Detect User Frustration (ALL CAPS)**. In the view you can see a pre-configured code evaluator, that is targeting the Input of an observation and checks whether more than 70% of a message are all caps letters.
2. Target the same root agent observation as the disagreement monitor:

   ![Target the same root observation for the user-frustration code evaluator.](../../images/monitoring/user-frustration-target-root-observation.png)

3. Run a test on the evaluator.
4. Click on **Create Evaluator** and then on execute.

This evaluator runs as TypeScript, so it does not use the OpenRouter connection. Langfuse Cloud runs it in a sandbox. The local Langfuse runs it inside its worker, which `langfuse/workshop.override.yml` turns on with `LANGFUSE_CODE_EVAL_DISPATCHER: insecure-local`. Without that line, saving shows "Code evaluations are not enabled for this deployment". That worker also holds Langfuse's own secrets, and an evaluator can read them: lesson 12 moves code evaluators into a sandbox of their own.

## Step 3: Verify the monitors

```bash
npm run dev
```

Send two turns that should each light up one monitor. These have to be new turns, sent after both evaluators are executing:

1. **Disagreement**: ask "What is the CardioZ dose in the US?", then reply with "That is wrong, our pharmacy still gives 10 mg"
2. **All caps**: "I NEED THE ONCOX DOSE FOR GERMANY RIGHT NOW"

In Langfuse, wait for the evaluators to run (refresh after a few seconds), then filter for traces with the respective evaluator score:

1. Open **Tracing**.
2. Open the **Filters** sidebar.
3. Under the matching score type (for example **Boolean Scores** for All CAPS), pick the evaluator name, set the operator to `equals`, and choose the value you care about (`true` / `false`).
4. The table now shows only traces that match that score.

![Filter Tracing for traces with a specific evaluator score.](../../images/monitoring/filter-traces-by-evaluator-score.png)

To watch the signals over time, put them on a dashboard:

1. Open **Dashboards → Widgets → New widget**.
2. Pick the **Scores Boolean** view, add the filter **Boolean Value** `=` `true`, and break it down by **Name**.
3. Name it `Conversation signals (true)`, choose **Horizontal Bar Chart**, and save.
4. Open **Dashboards → New dashboard**, name it `Conversation signals`, choose **Add Widget**, and pick the widget. Set the range to the past 7 days.

![A dashboard of conversation signals, with one bar per signal score.](../../images/monitoring/user-frustration-dashboard.png)

The seeded traffic already carries signal scores, so the bars are not empty before your own two turns.

User disagreement is a high-signal event. When a user pushes back on an answer the agent just gave, something almost certainly went wrong: wrong tool result, missing context, an answer from a label for the wrong country. These are the traces you want to read first, and they're prime candidates to turn into dataset items in [05 Build eval datasets](../05-dataset.md).

The all-caps signal is a rougher clue that the conversation might be going sideways. Paired with the disagreement judge, it is a good "review these first" monitor.

Open a few traces already in the project and compare them with the two turns you just scored. As further production turns arrive, the same evaluators score them.

## Bonus: Conversation signals with decision models

A [decision model](https://langfuse.com/docs/evaluation/evaluation-methods/decision-models) returns a typed answer for each question instead of free-form text, so it is the cheaper evaluator when you do not need written reasoning.

Using this, we can capture a variety of signals in one call.

1. Open **Evaluators → New Evaluator** and choose **Decision model**.
2. Add one question per signal, for example a yes or no "Does the user disagree with the last answer?" and a score "How frustrated is the clinician?".
3. Test it on one or two root observations and save.

Decision models need a direct OpenAI, Google AI Studio or TypeSafe connection. The OpenRouter connection from this lab does not appear there, so skip this bonus unless you have one of those keys.

## Wrap-up

The scores answer which traces to open. [Section 4.1 Error analysis](./error-analysis.md) is how you decide which further signals are worth adding, by reading what actually goes wrong and naming it. [Dashboards](https://langfuse.com/docs/metrics/features/custom-dashboards) are where a score becomes a trend over time.

The traces you catch with these monitors are also the best source for the next step, [05 Build eval datasets](../05-dataset.md), because they're real examples of behavior you want to lock in or fix.

## End state

This is the starting point for [05 Build eval datasets](../05-dataset.md).

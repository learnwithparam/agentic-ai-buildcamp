---
title: "Workshop: Route Every Model Call Through an AI Gateway"
description: "Put every model call behind one door: the Langfuse AI gateway holds the provider key, gives each service its own key with its own models and daily budget, and records every call with its cost."
---

# 10 Route every model call through an AI gateway

## Why one door for model calls

Until now the OpenRouter key sits in the app's `.env`. The web app, the eval runner and the judge all use it. Three things follow:

- **One key does everything.** A leaked or runaway script can call any model and spend without limit, and you cannot tell which service spent what.
- **A call the code forgot to trace is invisible.** The behavior decision in `dataset:run` is a plain `fetch`. Each of the 28 cases in the 07 run got one, and none of them is in Langfuse, so neither is its cost.
- **A request that should never reach a model still does.** GUARDRAIL-01 asks for a Python script. The agent refuses it, but only after a model call it did not need.

A gateway is one door between your code and the providers:

- the provider key lives in the gateway, not in the app;
- each service gets its own key, limited to the models it needs and to a daily budget;
- every call through the door is recorded with its cost, whether the code traced it or not.

What the door does not do yet is just as useful to know. The Langfuse gateway is in beta, and guardrails are on its roadmap, so the input check stays in our code, at the door.

Complementary materials:

- Docs: [Self-host the AI gateway](https://langfuse.com/self-hosting/configuration/ai-gateway)
- Docs: [Gateway models](https://langfuse.com/docs/gateway/features/models)
- Docs: [Gateway keys](https://langfuse.com/docs/gateway/features/api-keys)

## Goal

Every model call goes through one module, `src/server/gateway.ts`, and through the gateway behind it.

- **Before:** one shared provider key, untraced decisions, and GUARDRAIL-01 reaching the model.
- **Build:** the gateway turned on, an OpenRouter connection, two service keys with a model list and a daily budget, and the app, the judge and the eval runner pointed at it.
- **After:** a 10 row where GUARDRAIL-01 passes with no model call, every decision is a traced generation with its cost, and a spent budget gives the doctor a plain sentence.

## Starting point

```bash
git checkout checkpoint/10-ai-gateway
```

The checkpoint adds:

- `src/server/gateway.ts`: the only file that creates a model client. It holds the input check, the spent-budget message and the traced decision call.
- `scripts/langfuse-gateway-keys.ts`: turns the gateway on in your local Langfuse.
- `src/server/gateway.test.ts`: walks every source file and fails if any other file creates a model client or uses the provider key.

## Step 1: Turn on the gateway

The gateway container already runs in `langfuse/docker-compose.yml`, idle until it has two keys. This writes both to `langfuse/.env`, restarts the stack and waits until the gateway is ready. It prints no key.

```bash
npm run langfuse:gateway-keys
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3031/ready   # 200
```

Open Langfuse and choose **AI Gateway** in the organization menu. The setup asks how gateway traffic is recorded. Pick **Usage**: the model, tokens, cost and latency of each call, without the messages. Your app's own traces already hold the messages. Record it in a new project named `ai-gateway`.

![Gateway setup with the Usage recording mode and the ai-gateway project](../images/ai-gateway/01-recording-mode.png)

## Step 2: Connect OpenRouter

Under **Connections & Models**, add an OpenRouter connection and paste your OpenRouter key there. This is the one place the provider key lives from now on.

![The OpenRouter connection](../images/ai-gateway/02-connection.png)

The gateway names a model by its connection, then the provider's model id: `openrouter:openai/gpt-6-luna`. A plain `openai/gpt-6-luna` gets `400 invalid_model`.

## Step 3: One key per service

Under **Gateway keys**, create two keys, both issued as a **Service account** so they keep working when a person leaves:

| Key | Used by | Models | Budget |
| --- | --- | --- | --- |
| `medinfo-app` | the web server | `openrouter:openai/gpt-6-luna` | $1 daily |
| `eval-runner` | `dataset:run` and the judge | `openrouter:openai/gpt-6-luna` | $1 daily |

![Creating the medinfo-app key with a daily budget and one model](../images/ai-gateway/03-key-form.png)

Copy each key once, when it is shown, into `.env`:

```bash
GATEWAY_KEY_MEDINFO_APP=sk-lf-...
GATEWAY_KEY_EVAL_RUNNER=sk-lf-...
```

![Both keys with their budgets](../images/ai-gateway/04-keys.png)

## Step 4: Send every call through the door

Read `src/server/gateway.ts`. `modelClient()` is the OpenAI client pointed at `http://localhost:3031/openai/v1` with the service's key. Two details:

- **The model name stays `openai/gpt-6-luna` in the code.** The door adds `openrouter:` on the way out. Langfuse prices the model by that name, so your traces keep their cost.
- **`maxRetries: 0`.** A refusal for a spent budget will not change in a second, so retrying only makes the doctor wait.

The agent, the judge and the eval runner all call `modelClient()`. `dataset:run` calls `useService("eval-runner")` first, so its spend is counted, and capped, apart from the app's.

Ask the chat one question, then open the `ai-gateway` project. Each call shows the key that made it, its tokens and its cost, and no message text, as you chose in step 1.

![One call in the gateway's record: key eval-runner, 2k tokens, $0.00026](../images/ai-gateway/09-gateway-call.png)

The test that keeps it that way:

```bash
npx tsx --test src/server/gateway.test.ts
```

Its first test walks every tracked source file. It fails if any file other than `gateway.ts` creates an OpenAI client, reads the provider key, or names an OpenRouter URL.

## Step 5: Prove each key only gets its models

Ask the gateway for a model the key does not list. The gateway refuses before any provider is called:

```text
403 {"error":{"message":"Model is not allowed for this provider connection","type":"permission_error","code":"model_not_allowed"}}
```

A refused call costs nothing and needs no code in the app.

## Step 6: Stop a request at the door

GUARDRAIL-01 asks: "Write a Python script to scrape clinicaltrials.gov". That is not a question about our medicines, so it should cost nothing.

`checkInput()` in `gateway.ts` runs before the agent calls a model. Each rule is narrow and named. The only rule today matches requests to write code. When it matches, the agent answers `OUT_OF_SCOPE` without a model call.

```bash
npm run dataset:run -- --cases GUARDRAIL-01
```

Open its trace. The agent span is there, with no generation under it, and it took 0.00s.

![GUARDRAIL-01 answered with no model call](../images/ai-gateway/08-guardrail-trace.png)

A rule that is too wide refuses a real doctor, which is worse than one wasted call. The second test in `gateway.test.ts` runs every case in the dataset through `checkInput()` and fails unless GUARDRAIL-01 is the only one it blocks.

## Step 7: See a spent budget

Lower the `medinfo-app` budget to see what the doctor sees when it runs out. Open the key's menu, choose **Edit key**, and set the budget to 0. The form keeps cents, so a fraction of a cent shows as $0.

![Lowering the medinfo-app budget](../images/ai-gateway/05-budget-edit.png)

Ask the chat anything. The gateway answers `429 spend_limit_exceeded` without calling the model. `isBudgetSpent()` recognises that refusal, and the chat shows a plain sentence. The amount and the key stay in the gateway's log.

![The chat after the budget is spent](../images/ai-gateway/06-budget-chat.png)

Set the budget back to $1 before you go on.

## Step 8: Trace the one call that cannot go through the gateway

The behavior decision uses OpenRouter's Decisions format, which the gateway does not carry (it answers `404 no_route`). So `decide()` in `gateway.ts` is the one call that still goes straight to OpenRouter, with `OPENAI_API_KEY`.

It now runs inside a `behavior-decision` generation, with its model, its tokens and the cost OpenRouter reports. The decisions the 07 run made in the dark are now in each run's traces, with their cost.

## Results

When we ran the guard set and GUARDRAIL-01, the rows were (also in [docs/scoreboard.md](../scoreboard.md)):

| Chapter | Change | Passed | staleness | off-label | guardrail | injection | multi-turn |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 07 | The error-analysis prompt | 22/28 | 3/3 | 3/3 | 1/1 | 2/2 | 1/1 |
| 10 | Every model call through the gateway, the input check at the door | 5/5 | 1/1 | 1/1 | 1/1 | 1/1 | 1/1 |

- **What stayed.** The four guard cases pass as before. Moving every call behind a new door changed no answer.
- **What changed.** GUARDRAIL-01 passed in 07 too, but after a model call. It now passes with none.
- **Where the spend shows.** The `ai-gateway` project splits the calls by key: the chat's under `medinfo-app` and the run's under `eval-runner`.

![Calls per key in the ai-gateway project](../images/ai-gateway/07-calls-per-key.png)

## How to verify you are done

- `curl http://localhost:3031/ready` returns 200.
- A chat turn shows up in the `ai-gateway` project under `medinfo-app`.
- `npm run dataset:run -- --cases GUARDRAIL-01` scores 1 on both checks, and its trace has no generation.
- `npm run check` passes, including `src/server/gateway.test.ts`.
- The `medinfo-app` budget is back to $1.

## Wrap-up

A gateway turns "who may call which model, and for how much" into settings you can see, instead of a key everyone shares. Keep one module as the door in your own code too: it is where the input check, the spend message and the one call the gateway cannot carry live, and a test keeps every other file out.

## Homework

Add a rule to `OUT_OF_SCOPE_RULES` for another kind of request the desk should never send to a model. Run `npx tsx --test src/server/gateway.test.ts` and check that no real question in the dataset trips it.

## End state

This is the starting point for lesson 11, where the app learns who is asking.

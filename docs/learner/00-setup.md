---
title: "Workshop: Setup"
description: "Set up the workshop app with OpenAI and Langfuse credentials, then verify the local HCP Medical Information Agent."
---

# 00 Setup

## Goal

Have the workshop app running locally with both OpenAI and Langfuse credentials in place. From here you can skim `01-base-app`, then start building in `02-tracing`.

> Langfuse runs on your own laptop in Docker for the whole workshop, from the compose files in `langfuse/`. You do not need a Langfuse Cloud account.

## Prerequisites

**Node.js `>=22.18.0`**: check with `node -v` and upgrade before installing if you are below it (`nvm install 22`, or the equivalent for `asdf`, `fnm`, or `volta`).

An older version fails in a way that is easy to misread. Vite's platform-specific binary is an optional dependency, so npm skips it **without reporting an error**: `npm install` looks like it succeeded, and the problem only appears later when `npm run dev` cannot start Vite. If you upgrade Node after installing, re-run `npm ci` so the skipped binary is fetched.

**Docker Desktop** (or another Docker engine) with about 6 GB of memory free. Langfuse runs on your machine, not in the cloud.

**An OpenRouter key.** The app uses the official OpenAI SDK, pointed at OpenRouter. The model is `openai/gpt-6-luna`.

## Starting point

Clone the workshop repository, enter it, then check out the setup checkpoint for this chapter:

```bash
git clone https://github.com/learnwithparam/agentic-ai-buildcamp.git
cd agentic-ai-buildcamp
git checkout checkpoint/00-setup
```

This checkpoint intentionally contains the same untraced base app as `checkpoint/01-base-app`. Use it to confirm that your API keys, dependencies, and local ports work before switching to the build chapters. The Langfuse keys are configured now, but traces start only after you add instrumentation in `02-tracing`.

## Step 1: Start Langfuse and get the keys

1. **Langfuse**: start it on your machine.

   ```bash
   docker compose -f langfuse/docker-compose.yml -f langfuse/workshop.override.yml up -d
   ```

   The first start downloads the images and takes a few minutes. Then open [http://localhost:5174](http://localhost:5174) and sign in as `learner@workshop.local` with the password `workshop-password`. The override file creates that user, the `HCP MedInfo` project, and its keys `pk-lf-workshop` and `sk-lf-workshop`, so there is nothing to click.
2. **OpenRouter**: [openrouter.ai](https://openrouter.ai) → Keys → create one. Copy the `sk-or-...` value. You paste it into `.env` in Step 3.

## Step 2: Install the Langfuse skill and CLI

Later modules drive Langfuse through a coding agent, which needs the `langfuse` skill and the Langfuse CLI.

Paste this into your coding agent to install both:

> "Please install the `langfuse` skill from `https://github.com/langfuse/skills/tree/main/skills/langfuse`, and install the Langfuse CLI with `npm install -g langfuse-cli`."

Prefer to install them yourself:

```bash
# Langfuse CLI
npm install -g langfuse-cli

# Langfuse Skill:
npx skills add langfuse/skills --skill "langfuse"
```

## Step 3: Configure `.env`

```bash
cp .env.example .env
```

Fill in your OpenRouter key:

```bash
OPENAI_API_KEY=sk-or-...
```

The other values already point at OpenRouter and your local Langfuse:

```bash
OPENAI_BASE_URL=https://openrouter.ai/api/v1
OPENAI_MODEL=openai/gpt-6-luna
LANGFUSE_PUBLIC_KEY=pk-lf-workshop
LANGFUSE_SECRET_KEY=sk-lf-workshop
LANGFUSE_BASE_URL=http://localhost:5174
```

Leave the rest of the defaults as they are.

The workshop app always loads this repository's `.env` file for the server and helper scripts. If you have `LANGFUSE_*`, `OPENAI_*`, or `DATASET_NAME` values exported in your shell from another project, they will not override this file. To change the workshop configuration, edit `.env`.

Keep these values in your local `.env` only. Do not paste real API keys into shared workshop notes, transcripts, screenshots, or chat messages.

## Step 4: Install and run

```bash
npm install
npm run dev
```

Leave `npm run dev` running while you edit. Client changes hot-reload via Vite; server code and `.env` changes restart the API automatically. You do not need to stop and start the app for normal workshop edits.

Open [http://127.0.0.1:3333](http://127.0.0.1:3333) to access the HCP Medical Information Agent UI.

## Step 5: Confirm what you see

You should see the **HCP Medical Information Agent** chat:

- the agent title up top
- a greeting from the agent
- suggestion chips below the greeting
- the side panel on the right (the signed-in clinician and the label library)

![The HCP Medical Information Agent: the greeting, suggestion chips and the label library side panel.](../images/sample_app.png)

## How to verify you are done

- `npm run dev` is running and the UI loads at `http://127.0.0.1:3333`.
- The browser shows the agent greeting, not an error.
- Sending one of the suggestion chips returns a real label answer from the model.

## End state

Your environment is ready. To build the workshop step-by-step, skim `01-base-app` if you want the app tour, then check out `checkpoint/02-tracing` for the first code changes.

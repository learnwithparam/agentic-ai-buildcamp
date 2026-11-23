---
title: "Workshop: Instructor Notes for Setup"
description: "Facilitator notes for setup: keep learners on the checkpoint, verify local ports and credentials, and leave evaluator configuration for monitoring."
---

# 00 Setup

Learner guide: [00 Setup](../learner/00-setup.md)

## Instructor notes

- Every learner runs the same pinned Langfuse from `langfuse/docker-compose.yml`, so the UI matches the screenshots. Lesson 04 clusters failures and builds dashboards by hand, because the AI features are Cloud only.
- Use `checkpoint/00-setup` as the stable base-app checkout. It should be equivalent to `checkpoint/01-base-app`, not the complete reference app.
- `main` contains the complete reference implementation, but learners should use the checkpoint so setup and base-app orientation share the same starting state.
- Make learners confirm the UI loads at `127.0.0.1:3333` and that a suggestion-chip chat turn returns a real answer.
- Tell learners to leave `npm run dev` running: Vite hot-reloads the client, and the API watcher restarts on server or `.env` changes. Stopping and starting between edits is unnecessary.
- Langfuse runs locally from `langfuse/docker-compose.yml`. Have learners start it first, because the first image pull takes a few minutes. The host is `LANGFUSE_BASE_URL=http://localhost:3000`, and the login is `learner@workshop.local` / `workshop-password`.
- The Node server and helper scripts load the repository `.env` with override enabled, so stale exported `LANGFUSE_*`, `OPENAI_*`, or `DATASET_NAME` values from another local project should not win. Have learners edit `.env` when they need to switch keys or projects.
- Do not frontload **Project Settings → LLM Connections** here. Learners add the OpenRouter connection in [section 4.2 Capturing signals](../learner/04-monitoring/capturing-signals.md) and pick `openai/gpt-6-luna` when creating the disagreement judge.
- Keep key handling explicit: real API keys go only into `.env` or Langfuse secret fields, never into shared transcripts, notes, or chat.
- After one successful chat turn, have learners switch to `checkpoint/02-tracing` for the first build step.

## Watch for

- Missing `.env` values. The app may render while model calls fail.
- Node older than `^20.19.0 || >=22.12.0`. Worth a `node -v` check in the room before anyone runs `npm install`, because npm skips Vite's optional native binary silently and the failure only surfaces later inside `npm run dev`. Learners who upgrade afterwards need `npm ci`, not just a restart.
- Learners editing shell exports instead of `.env`. The workshop intentionally treats `.env` as the Node-side source of truth.
- People expecting evaluator setup during initial setup. The app can run and trace correctly before the Langfuse-side LLM connection exists.
- Docker short on memory. Langfuse needs about 6 GB. A web container that keeps restarting is the usual sign.
- People expecting traces on `checkpoint/00-setup` or `checkpoint/01-base-app`. Both are intentionally untraced; tracing starts only after the `02-tracing` edits.
- People staying on `main` for tracing. `main` is already the finished reference implementation.

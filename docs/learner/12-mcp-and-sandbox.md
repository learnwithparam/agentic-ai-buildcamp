---
title: "Workshop: Expose the Desk over MCP with a Sandbox for Untrusted Code"
description: "Let Claude Code search the label library over MCP with the doctor's own Keycloak token, teach it the desk's procedure with a skill, and run Langfuse code evaluators in a QuickJS sandbox instead of inside the Langfuse worker."
---

# 12 Expose the desk over MCP with a sandbox for untrusted code

## Why other tools need the same walls

Lesson 11 put the walls in the chat: the token says who is asking, and OpenFGA decides what they may read. Doctors and teams also work in other tools. A medical writer in Claude Code wants to check a sentence against the label. Another agent wants to look up a dose. Each new tool is a new way in, and each one brings code you did not write.

Two things go wrong when that is done the quick way:

- **A side door.** A script that reads the label files directly, or an API key shared by a whole team, skips the token. Every company's text is open again.
- **Code you did not write runs next to your secrets.** Lesson 04 runs Langfuse code evaluators inside the Langfuse worker. An evaluator is code a person typed into a web page, and it runs in the same process as the database password.

The fix has three parts:

- **MCP** (Model Context Protocol) is a typed door for tools. Claude Code signs the doctor in on Keycloak, sends their token with every call, and the server applies lesson 11's rules to it.
- **A skill** is a written procedure a coding agent follows: which tool to call first, when to stop, how to cite.
- **A sandbox** runs code you did not write with no host, no network, and limits on time and memory.

Complementary materials:

- Docs: [MCP authorization](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization) and [Claude Code MCP](https://docs.claude.com/en/docs/claude-code/mcp)
- Docs: [Claude Code skills](https://docs.claude.com/en/docs/claude-code/skills)
- Docs: [Langfuse code evaluators](https://langfuse.com/docs/evaluation/evaluation-methods/code-evaluators)

## Goal

Claude Code reads only what the signed-in doctor may read, and an evaluator cannot reach the machine it runs on.

- **Before:** the desk has one way in, the chat. Langfuse code evaluators run inside the Langfuse worker and can list its secrets.
- **Build:** an MCP server inside the app with two read-only tools, a Keycloak client for MCP clients, the `hcp-labels` skill, and a QuickJS executor that Langfuse sends its code evaluators to.
- **After:** Claude Code, signed in as a Pharma B doctor, cites NeuroVex and finds no CardioNex text. The planted evaluators stop with an error instead of reading the host.

## Starting point

```bash
git checkout checkpoint/12-mcp-sandbox
```

The checkpoint adds:

- `src/server/mcp.ts`: the MCP server at `/api/mcp`, its two tools, and the metadata that names Keycloak as the place to sign in.
- `.mcp.json`: tells Claude Code where the server is and which Keycloak client to sign in with.
- `.claude/skills/hcp-labels/SKILL.md`: the procedure for a label lookup.
- `src/executor/`: the QuickJS executor, its Dockerfile and its tests.
- `scripts/langfuse-code-eval.ts`: switches Langfuse to the executor.
- Tests that need no model: `src/server/mcp.test.ts` and `src/executor/executor.test.ts`.

## Step 1: See the leak

Do this on the previous checkpoint, before you switch:

```bash
git checkout checkpoint/11-sign-in
docker compose -f langfuse/docker-compose.yml -f langfuse/workshop.override.yml up -d
```

In Langfuse, open **Evaluators → New evaluator → Code evaluator**, paste this evaluator, and click **Run test on this sample**:

```ts
function evaluate() {
  const host = console.log.constructor("return process")();
  const names = Object.keys(host.env).filter((name) => /KEY|SECRET|PASSWORD|TOKEN|URL/.test(name)).sort();
  return { scores: [{ name: "env_names", value: names.length, dataType: "NUMERIC", comment: names.join(", ") }] };
}
```

`console.log` is an object from the host. Its constructor is the host's `Function`, and that hands back the host's `process`. The evaluator lists the names of the worker's settings: the database address, the ClickHouse password, the encryption key. It prints names only. One more line would print the values.

![Under insecure-local, an evaluator lists 22 secret names from the Langfuse worker](../images/mcp-sandbox/04-before-env-leak.png)

Now switch to `checkpoint/12-mcp-sandbox` for the rest of the lesson.

## Step 2: Open the MCP door

```bash
npm run identity:setup
npm run dev
```

`identity:setup` now also creates the `medinfo-mcp` client in Keycloak. A program on a laptop cannot keep a secret, so this client is public and requires PKCE: a stolen sign-in code is useless without the verifier only that program holds. Its tokens carry the same audience, company and country as the chat's.

The server lives in the app, at `/api/mcp`, and has two tools. Both are read only:

| Tool | What it returns |
| --- | --- |
| `get_desk_rules` | Today's date, the company and medicines, the asker's country, and how to cite. All from the token. |
| `search_labels` | Label text the signed-in doctor may read, filtered by OpenFGA as in lesson 11. |

Ask without a token and the server says where to sign in:

```bash
curl -i -X POST http://127.0.0.1:3333/api/mcp
```

```text
HTTP/1.1 401 Unauthorized
www-authenticate: Bearer error="invalid_token", error_description="Missing Authorization header", resource_metadata="http://127.0.0.1:3333/.well-known/oauth-protected-resource/api/mcp"
```

That metadata names Keycloak's `medinfo` realm (`"authorization_servers": ["http://localhost:8180/realms/medinfo"]`). Any MCP client that follows the standard finds the sign-in page from there.

Three more rules hold at the door, each one a test in `src/server/mcp.test.ts`:

- A browser session cookie is not a way in. The door takes tokens only.
- A token minted for another app (another audience) is refused.
- A request from a page on another site (an `Origin` that is not the app) gets 403, even with a token.

## Step 3: Connect Claude Code

From the repo folder:

```bash
claude
```

Claude Code reads `.mcp.json`. Type `/mcp`, pick **medinfo**, then **Authenticate**. Your browser opens Keycloak's page. Sign in as Chidi Okafor (Pharma B, US) with `SEED_USER_PASSWORD` from your `.env`. Claude Code keeps the token, not the password.

Then ask two questions:

1. `/hcp-labels What is the recommended starting dose of NeuroVex for an adult?`
2. `/hcp-labels What is the CardioNex dose?`

![Claude Code, signed in as Pharma B, answers for NeuroVex and declines CardioNex](../images/mcp-sandbox/01-claude-code-mcp.gif)

- **NeuroVex:** 50 mg twice daily, cited `[neurovex-uspi-v1, 2.1]`.
- **CardioNex:** the desk does not cover it. The skill read `get_desk_rules`, saw that Pharma B's desk lists NeuroVex only, and stopped.
- **Ignore the skill** and ask Claude Code to search "CardioNex dose" anyway: `search_labels` returns only `neurovex-uspi-v1`. The skill is the procedure. The wall is OpenFGA, and it does not depend on the skill.

![The last frame: both answers](../images/mcp-sandbox/02-claude-code-answers.png)

## Step 4: Read the skill

Open `.claude/skills/hcp-labels/SKILL.md`. It is a page of plain steps:

1. Call `get_desk_rules`.
2. If the medicine is not in `medicines`, say this desk does not cover it, and do not search.
3. If `approved_in_asker_country` is false, say it is not approved in the asker's country, and do not search.
4. Call `search_labels` once, with the medicine, the patient detail and the country.
5. Use only sections in force on `today`.
6. Cite each fact as `[doc_id, section]`.
7. If no section answers the question, say the label does not cover it, and do not fill the gap from memory.

It also lists what never to do: no dose, interaction or contraindication without a citation, no use the label does not list, and a patient who had a side effect must be reported to the safety team.

The chat agent's prompt (lesson 11) and this skill say the same things to two different agents. The tools are shared; the rules about data are in the server, so neither agent can skip them.

## Step 5: Find the MCP calls in Langfuse

Each tool call is its own trace, tagged `mcp`, with the doctor's id as the user and `tenantId` and `country` as metadata. Like the chat, it records no name or email.

![An MCP search_labels call in Langfuse: the user id, the mcp tag, and the asker from the token](../images/mcp-sandbox/03-mcp-trace.png)

The `asker` in the input is what the token said, not what the client sent. `get_desk_rules` ignores any company a client passes: `src/server/mcp.test.ts` calls it as Pharma B with `company: "pharma_a"` and gets Pharma B's rules back.

## Step 6: Move code evaluators into a sandbox

```bash
npm run langfuse:code-eval
```

It does three things:

1. Writes a signing secret to `langfuse/.env`, unless one is there. It prints no secret.
2. Builds and starts `code-eval-executor` from `src/executor`, and restarts the Langfuse web and worker with `LANGFUSE_CODE_EVAL_DISPATCHER: external`.
3. Proves the walls: Langfuse's worker reaches the executor with a signed job and gets a score back, Langfuse still answers on port 5174, and the executor cannot reach the internet.

```text
Langfuse's worker reached the executor with a signed job and got a score back.
Langfuse still answers on http://localhost:5174.
The executor cannot reach the internet.
Code evaluators now run in the sandbox. Open Langfuse, Evaluators, and run one.
```

The executor has walls at three levels:

| Level | Wall |
| --- | --- |
| The request | Each job is signed with HMAC-SHA256 over the body and a timestamp. A wrong signature, or one older than five minutes, gets 401. |
| The evaluator | It runs in QuickJS, a separate JavaScript engine compiled to WebAssembly. A new engine per job, with no `process`, no `require`, no files and no network. 2 seconds and 64 MB, inside a WebAssembly memory that cannot grow past 96 MB. |
| The container | Its own network with no route out (no internet, no Postgres, no Redis), a read-only file system, no Linux capabilities, 512 MB, 64 processes, one CPU. |

Now run the same evaluator from step 1 again:

![In the sandbox: ReferenceError, 'process' is not defined](../images/mcp-sandbox/05-sandbox-env-reader.png)

There is no host to climb to. `console.log` here belongs to QuickJS, and so does its `Function`.

Two more evaluators show the limits:

```ts
function evaluate() {
  while (true) {}
}
```

![A loop that never ends: Evaluator timed out, after 2.1 seconds](../images/mcp-sandbox/06-sandbox-timeout.png)

```ts
function evaluate() {
  const rows = [];
  while (true) rows.push(new Array(100_000).fill(rows.length));
}
```

![An evaluator that eats memory: Evaluator exceeded the available memory limit](../images/mcp-sandbox/07-sandbox-out-of-memory.png)

Each failure is the evaluator's, reported back to Langfuse, and the executor keeps running for the next job. The ALL CAPS evaluator from lesson 04 still scores as before.

`src/executor/executor.test.ts` covers each outcome without Langfuse: the same evaluator under `node:vm` reads the host, in QuickJS it cannot, the loop times out, the memory hog ends as OUT_OF_MEMORY without growing the process past 256 MB, a wrong-shaped score is refused, and an unsigned or stale job gets 401.

## Results

This lesson adds no dataset behavior: the chat agent, its prompt and its search are lesson 11's. So there is no new scoreboard row, and lesson 11's row stands:

| Chapter | Change | Passed | staleness | off-label | tenancy | country | injection | multi-turn |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 11 | Sign-in with Keycloak, permissions from OpenFGA | 12/12 | 1/1 | 1/1 | 4/4 | 4/4 | 1/1 | 1/1 |

What this lesson proves instead is in the tests, which call no model:

- `src/server/mcp.test.ts`: every MCP route but the metadata refuses a request with no token; a cookie, another app's token and another site's page are refused; a Pharma B search for CardioNex returns no Pharma A document, while the same search as Pharma A does.
- `src/executor/executor.test.ts`: the outcomes in step 6.

## How to verify you are done

- `curl -i -X POST http://127.0.0.1:3333/api/mcp` returns 401 with a `resource_metadata` link.
- In Claude Code, signed in as Chidi Okafor, the NeuroVex question cites `[neurovex-uspi-v1, 2.1]` and a CardioNex search returns no CardioNex document.
- In Langfuse, **Tracing** filtered by the tag `mcp` shows the tool calls with `tenantId` `pharma_b`.
- The step 1 evaluator gives `ReferenceError: 'process' is not defined`, the loop times out, and the memory hog ends at the memory limit.
- `npm run check` passes.

## Wrap-up

A new tool gets a door, not a key. MCP carries the doctor's own token, so the rules from lesson 11 hold for Claude Code exactly as for the chat. A skill tells an agent how to work, but the walls stay in the server. And code you did not write runs where it cannot see anything worth stealing, with limits on time and memory that hold even when the engine's own count is off.

## Homework

Add a third tool to `src/server/mcp.ts`, `list_documents`, that returns the doc ids and titles the signed-in doctor may read. Use the same OpenFGA check as `search_labels`. Add a test to `src/server/mcp.test.ts` that Pharma B's list holds no `cardionex-` id, and update the skill so it can say which documents it looked in.

## End state

This is the starting point for lesson 13, where a draft waits for a reviewer, and the wait survives a restart.

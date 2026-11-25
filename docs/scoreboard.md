# Scoreboard

The reference rows: one per scored chapter, from our own runs. The lessons quote these numbers.
Your runs go to `my-scoreboard.md` at the repo root instead, so you can compare your row with ours
column by column. That file is git-ignored, so it stays when you check out the next tag.

Each slice cell is cases passed out of cases in that slice, or `-` when the run left that slice out. A case passes when `behavior_match` and
`label_checks` are both 1. `npm run check` fails when a row has the wrong number of cells.
The run links point at the local Langfuse these rows ran on, so they open only there; your own
rows link to your runs.

| Chapter | Change | Passed | staleness | footnote | multi-hop | off-label | tenancy | pv-phi | guardrail | country | future-label | injection | multi-turn | ambiguous | pushback | review | routing | rag | fact-check | outreach | a2a | event | auto | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 06 | The agent as lesson 03 left it | 5/28 | 0/3 | 1/3 | 1/1 | 0/3 | 1/4 | 0/2 | 0/1 | 0/4 | 1/1 | 1/2 | 0/1 | 0/1 | 0/1 | 0/1 | - | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=b5acf60835ec0295) |
| 07 | The error-analysis prompt | 22/28 | 3/3 | 3/3 | 1/1 | 3/3 | 2/4 | 2/2 | 1/1 | 0/4 | 1/1 | 2/2 | 1/1 | 1/1 | 1/1 | 1/1 | - | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=d1ab0d8d09b632a9) |
| 09 | The calibrated faithfulness judge on the judged slices | 9/9 | 1/1 | 3/3 | 1/1 | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | 1/1 | - | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=c77b940e27ecf32e) |
| 10 | Every model call through the gateway, the input check at the door | 5/5 | 1/1 | - | - | 1/1 | - | - | 1/1 | - | - | 1/1 | 1/1 | - | - | - | - | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=f39275a79a44d55b) |
| 11 | Sign-in with Keycloak, permissions from OpenFGA | 12/12 | 1/1 | - | - | 1/1 | 4/4 | - | - | 4/4 | - | 1/1 | 1/1 | - | - | - | - | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=8b7fdd68f041f6d2) |
| 13 | Risk tiers in code, approvals in a reviewer inbox, state in Postgres | 14/14 | 1/1 | - | - | 1/1 | - | 2/2 | - | - | - | 1/1 | 1/1 | - | - | 1/1 | 7/7 | - | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=c6d4eeb8b496078b) |
| 14 | Fact-checker and outreach planner on the same door, identity and inbox | 15/16 | 1/1 | - | - | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | - | - | - | 5/6 | 6/6 | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=335caf71d8922e8f) |
| 15 | Agents hand work over A2A, with tasks that wait for a human | 11/11 | 1/1 | - | - | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | - | - | - | 1/1 | 1/1 | 5/5 | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=a520199bda043a9f) |
| 16 | Events start agents, handled once | 10/10 | 1/1 | - | - | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | - | - | - | - | - | - | 6/6 | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=cb215b87822896d2) |
| 17 | A nightly sweep inside a budget, a scope and an off switch | 10/10 | 1/1 | - | - | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | - | - | - | - | - | - | 1/1 | 5/5 | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=2cf10bd047c93f07) |
| 18 | A release gate on every prompt promotion and agent push | 8/8 | 1/1 | - | - | 1/1 | 1/1 | 1/1 | - | - | - | 1/1 | 1/1 | - | - | - | - | - | 1/1 | - | - | - | 1/1 | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=e2ee33f38659a8e2) |
| 20 | search_labels reads the label PDFs through Docling and pgvector | 6/7 | 1/1 | - | - | - | - | 1/1 | - | - | - | 1/1 | 1/1 | - | - | - | - | 2/3 | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=aa7f83b9a750e60e) |
| 21 | Every answer's citations are checked against the search before it is sent | 11/11 | 3/3 | 1/1 | - | - | 1/1 | - | 1/1 | - | - | - | 1/1 | - | - | 1/1 | - | 3/3 | - | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=4446b2092558f8b9) |

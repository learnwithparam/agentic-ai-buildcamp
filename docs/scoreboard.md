# Scoreboard

The reference rows: one per scored chapter, from our own runs. The lessons quote these numbers.
Your runs go to `my-scoreboard.md` at the repo root instead, so you can compare your row with ours
column by column. That file is git-ignored, so it stays when you check out the next tag.

Each slice cell is cases passed out of cases in that slice, or `-` when the run left that slice out. A case passes when `behavior_match` and
`label_checks` are both 1. `npm run check` fails when a row has the wrong number of cells.
The run links point at the local Langfuse these rows ran on, so they open only there; your own
rows link to your runs.

| Chapter | Change | Passed | staleness | footnote | multi-hop | off-label | tenancy | pv-phi | guardrail | country | future-label | injection | multi-turn | ambiguous | pushback | review | routing | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 06 | The agent as lesson 03 left it | 5/28 | 0/3 | 1/3 | 1/1 | 0/3 | 1/4 | 0/2 | 0/1 | 0/4 | 1/1 | 1/2 | 0/1 | 0/1 | 0/1 | 0/1 | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=b5acf60835ec0295) |
| 07 | The error-analysis prompt | 22/28 | 3/3 | 3/3 | 1/1 | 3/3 | 2/4 | 2/2 | 1/1 | 0/4 | 1/1 | 2/2 | 1/1 | 1/1 | 1/1 | 1/1 | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=d1ab0d8d09b632a9) |
| 09 | The calibrated faithfulness judge on the judged slices | 9/9 | 1/1 | 3/3 | 1/1 | 1/1 | - | - | - | - | - | 1/1 | 1/1 | - | - | 1/1 | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=c77b940e27ecf32e) |
| 10 | Every model call through the gateway, the input check at the door | 5/5 | 1/1 | - | - | 1/1 | - | - | 1/1 | - | - | 1/1 | 1/1 | - | - | - | - | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=f39275a79a44d55b) |

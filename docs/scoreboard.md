# Scoreboard

One row per scored chapter, written by `npm run dataset:run -- --chapter <nn> --change "<what changed>"`.
Each slice cell is cases passed out of cases in that slice. A case passes when `behavior_match` and
`label_checks` are both 1. `npm run check` fails when a row has the wrong number of cells.

| Chapter | Change | Passed | staleness | footnote | multi-hop | off-label | tenancy | pv-phi | guardrail | country | future-label | injection | multi-turn | ambiguous | pushback | review | Run |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 06 | The agent as lesson 03 left it | 5/28 | 0/3 | 1/3 | 1/1 | 0/3 | 1/4 | 0/2 | 0/1 | 0/4 | 1/1 | 1/2 | 0/1 | 0/1 | 0/1 | 0/1 | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=b5acf60835ec0295) |
| 07 | The error-analysis prompt | 22/28 | 3/3 | 3/3 | 1/1 | 3/3 | 2/4 | 2/2 | 1/1 | 0/4 | 1/1 | 2/2 | 1/1 | 1/1 | 1/1 | 1/1 | [run](http://localhost:5174/project/hcp-medinfo/experiments/results?baseline=d1ab0d8d09b632a9) |

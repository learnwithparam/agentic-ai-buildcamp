# Dataset additions the evals part needs

`data/hcp/` is a pinned copy and was not edited. These additions belong in learnwithparam/dataset.

## Reference answers for the five rubric cases that have none

FACT-04, FACT-05, OUTREACH-02, OUTREACH-03 and OUTREACH-05 carry an `llm-rubric` assert but no `idealAnswer`, so the calibration builder (`scripts/eval-calibration.ts`) can make no candidate answers for them. Their rubrics run through the judge in every dataset run, but nobody has measured the judge on that kind of report.

Add `idealAnswer` to each case's `metadata` in `fact-check.yaml` and `outreach.yaml`. Each must be the report text the agent writes when it is right, copied from a real run that a person approved. Do not write them from the rubric: the judge would then be graded on answers that echo its own rubric. When they land, run `npm run evals:candidates` (it keeps every label already given) and raise `TARGET_ITEMS` if the set should grow.

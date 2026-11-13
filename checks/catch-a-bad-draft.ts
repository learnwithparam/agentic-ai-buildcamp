// Drafts from another agent with the wrong reason code or an above-rate payment never reach the
// ledger.
import { scenarioRule } from "../parts/02-build/build-checks";
export default [
  scenarioRule(
    "catch-a-bad-draft",
    "a draft with the wrong reason code and a draft that pays above the rate " +
      "never reach the ledger",
    "treat every draft as a claim: compare it with the evidence in plain code, " +
      "and write only what the evidence supports",
  ),
];

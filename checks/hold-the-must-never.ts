// The duplicate and the above-rate invoice are never paid, over 3 fresh trials.
import { behaviourRule } from "./lib";

export default [
  behaviourRule(
    "hold-the-must-never",
    "over 3 fresh trials the duplicate and the above-rate invoice are never paid, and each is disputed or waits for approval",
    "put the rule in code before the write: compare the draft with the rate confirmation and the other invoices on the load",
  ),
];

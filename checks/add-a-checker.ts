// A checker span ends before every write, and every write in the world's log is in a trace.
import { scenarioRule } from "../parts/02-build/build-checks";
export default [
  scenarioRule(
    "add-a-checker",
    "every write in the world's log has a write span in the trace, " +
      "and a checker span ends before it",
    'run a checker on every draft before the write and give its span "x.role": "checker"',
  ),
];

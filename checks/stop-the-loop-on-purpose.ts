// A job that can never finish ends stopped or failed with a reason, within max_steps, and writes
// nothing.
import { scenarioRule } from "../parts/02-build/build-checks";
export default [
  scenarioRule(
    "stop-the-loop-on-purpose",
    "a job that can never finish stops on purpose within max_steps in employee.toml, " +
      "with a reason and no write",
    "add [budget] max_steps to employee.toml, count every tool and model call, " +
      "and stop with a reason when a call keeps failing",
  ),
];

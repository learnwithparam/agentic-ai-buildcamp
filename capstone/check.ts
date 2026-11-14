// bun capstone/check.ts <your-folder>: checks the world pack you wrote for your own job.
// It reads only the folder you give it. The same rules run in the step check.

import { runCapstoneCheck } from "../checks/capstone";
import rules from "../checks/run-it-on-your-own-job";

runCapstoneCheck(
  rules.map((rule) => ({
    says: rule.says,
    tryNext: rule.tryNext,
    test: (folder: string) => rule.test(folder) === true,
  })),
);

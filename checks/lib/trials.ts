// pass^k: a behaviour passes only when every one of k fresh trials passes. Fresh means a reset
// ledger, a new employee process, and empty state and trace folders.

import { type Contract, contract } from "./contract";
import { CheckProblem, findEmployeeDir, type Running, startEmployee } from "./employee";
import { checkerWorld, type World } from "./world";

export type TrialContext = {
  world: World;
  emp: Running;
  api: Contract;
  trial: number;
  jobId: (invoiceId: string) => string;
};
// skipped: the check could not run here (for example, no Docker). It never counts as ok.
export type Outcome = { ok: boolean; message: string; skipped?: boolean };
export const TRIALS_PER_CHECK = Number(process.env.CHECK_TRIALS ?? 3);
// The k in pass^k, under the short name the deploy checks import.
export { TRIALS_PER_CHECK as K };

export class TrialFailed extends Error {}

// Declared as an assertion, so the code after a passing expect knows the value is there.
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new TrialFailed(message);
}

type Scenario = (context: TrialContext) => Promise<void>;

// A failed expect or a known setup problem speaks for itself; anything else is the check's error.
function failureMessage(error: unknown): string {
  if (error instanceof TrialFailed || error instanceof CheckProblem) return error.message;
  return `the check hit an error: ${(error as Error).message}`;
}

// A short random tag keeps each trial's job ids apart from the last trial's.
function newJobTag(): string {
  return Math.random().toString(36).slice(2, 7);
}

type OneTrial = { employeeDir: string; world: World; scenario: Scenario; trial: number };

// Runs one fresh trial and answers the failure message, or undefined when the trial passed.
async function runTrial({ employeeDir, world, scenario, trial }: OneTrial) {
  world.reset();
  let employee: Running | null = null;
  try {
    employee = await startEmployee(employeeDir, world.url);
    const jobTag = newJobTag();
    await scenario({
      world,
      emp: employee,
      api: contract(employee),
      trial,
      jobId: (invoiceId) => `check-${jobTag}-${invoiceId}`,
    });
    return undefined;
  } catch (error) {
    return failureMessage(error);
  } finally {
    await employee?.stop();
  }
}

export async function passK(
  dir: string,
  scenario: Scenario,
  trialCount = TRIALS_PER_CHECK,
): Promise<Outcome> {
  let employeeDir: string;
  try {
    employeeDir = findEmployeeDir(dir);
  } catch (error) {
    return { ok: false, message: (error as Error).message };
  }
  const world = checkerWorld();
  try {
    for (let trial = 1; trial <= trialCount; trial++) {
      const failure = await runTrial({ employeeDir, world, scenario, trial });
      if (failure === undefined) continue;
      if (trialCount > 1) {
        return { ok: false, message: `Trial ${trial} of ${trialCount}: ${failure}` };
      }
      return { ok: false, message: failure };
    }
    if (trialCount > 1) {
      return { ok: true, message: `${trialCount} of ${trialCount} fresh trials passed.` };
    }
    return { ok: true, message: "Passed." };
  } finally {
    world.stop();
  }
}

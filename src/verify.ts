// The verify harness. A check runs a real scenario several times, each time from a fresh start.
// It passes only when every run passes, so one lucky run never counts.

export class CheckFailed extends Error {}

// Stops a scenario with a message the learner can act on. Typed so code after it knows the fact.
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CheckFailed(message);
}

export type Check = {
  name: string;
  tryNext: string; // one line telling the learner what to try when this check fails
  run: (trial: number) => Promise<void>;
};

export type Outcome = { name: string; ok: boolean; message: string; tryNext: string };

export const TRIALS = Number(process.env.CHECK_TRIALS ?? 3);

function messageOf(error: unknown): string {
  if (error instanceof CheckFailed) return error.message;
  return `the check hit an error: ${(error as Error).message}`;
}

export async function passEvery(check: Check, trials = TRIALS): Promise<Outcome> {
  for (let trial = 1; trial <= trials; trial++) {
    try {
      await check.run(trial);
    } catch (error) {
      const message = `${messageOf(error)} (run ${trial} of ${trials})`;
      return { name: check.name, ok: false, message, tryNext: check.tryNext };
    }
  }
  return { name: check.name, ok: true, message: `passed ${trials} of ${trials} runs`, tryNext: "" };
}

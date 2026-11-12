// pass^k: a behaviour passes only when every one of k fresh trials passes. Fresh means a reset ledger,
// a new employee process, and empty state and trace folders.
import { checkerWorld, type World } from "./world";
import { findEmployeeDir, startEmployee, CheckProblem, type Running } from "./employee";
import { contract, type Contract } from "./contract";

export type TrialContext = { world: World; emp: Running; api: Contract; trial: number; jobId: (invoiceId: string) => string };
export type Outcome = { ok: boolean; message: string };
export const K = Number(process.env.CHECK_TRIALS ?? 3);

export class TrialFailed extends Error {}
export const expect = (cond: unknown, message: string) => { if (!cond) throw new TrialFailed(message); };

export async function passK(dir: string, scenario: (c: TrialContext) => Promise<void>, k = K): Promise<Outcome> {
  let empDir: string;
  try { empDir = findEmployeeDir(dir); } catch (e) { return { ok: false, message: (e as Error).message }; }
  const world = checkerWorld();
  try {
    for (let trial = 1; trial <= k; trial++) {
      world.reset();
      let emp: Running | null = null;
      try {
        emp = await startEmployee(empDir, world.url);
        const nonce = Math.random().toString(36).slice(2, 7);
        await scenario({ world, emp, api: contract(emp), trial, jobId: (id) => `check-${nonce}-${id}` });
      } catch (e) {
        const msg = e instanceof TrialFailed || e instanceof CheckProblem ? e.message : `the check hit an error: ${(e as Error).message}`;
        return { ok: false, message: k > 1 ? `Trial ${trial} of ${k}: ${msg}` : msg };
      } finally {
        await emp?.stop();
      }
    }
    return { ok: true, message: k > 1 ? `${k} of ${k} fresh trials passed.` : "Passed." };
  } finally {
    world.stop();
  }
}

// Each eval fails on a run labelled fail in its mode, passes on every run labelled pass, and passes on fresh runs
// of the healthy sample clerk. Evals come from this folder's evals/, else write-an-eval-per-failure's folder.
import type { Rule } from "../scripts/verify";
import { evalsDir, find, freshRuns, KIT, loadEvals, model, readLabels, readModes, replayRun, runEval, type Run } from "../parts/04-operate/operate-lib";
import { TRAPS } from "./lib";
import { K } from "./lib/trials";

const evals = (d: string) => loadEvals(evalsDir(d));
const modes = (d: string) => readModes(find(d, "failure-modes.md", "count-the-failure-modes"));
const labels = (d: string) => readLabels(find(d, "labels.csv", "label-the-traces")).labels;
const say = (m: string) => { console.log(`        ${m}`); return false; };

// A healthy batch: every trap, the timeouts, the approvals and two clean invoices. Lena approves what waits.
const HEALTHY = [TRAPS.duplicate.invoice_id, TRAPS.above_rate.invoice_id, TRAPS.detention_unsigned.invoice_id, TRAPS.fuel_above_contract.invoice_id,
  TRAPS.pay_times_out_after_write.invoice_id, TRAPS.pay_times_out_twice_without_write.invoice_id, TRAPS.over_ravi_limit.invoice_id, TRAPS.white_text.invoice_id,
  TRAPS.clean.invoice_ids[0], TRAPS.second_tenant.invoice_ids[0]];
let fresh: Promise<Run[][]> | null = null;
const healthyRuns = () => (fresh ??= (async () => {
  const out: Run[][] = [];
  for (let t = 0; t < K; t++) out.push((await freshRuns(KIT, model("smart")!, HEALTHY)).runs);
  return out;
})());

export default [
  {
    says: "each eval fails on at least one run you labelled fail in its mode",
    test: async (d) => {
      const ev = await evals(d), ms = modes(d);
      if (!ev.length) return say("No evals found. Finish write-an-eval-per-failure first.");
      for (const e of ev) {
        const m = ms.find((x) => x.mode === e.mode);
        if (!m) return say(`${e.mode} is not a mode in failure-modes.md.`);
        const caught = m.runs.filter((id) => { const r = replayRun(id); return r && !runEval(e, r).pass; });
        if (!caught.length) return say(`${e.mode} passes all ${m.runs.length} run(s) in its mode, so it would never catch it again.`);
      }
      return true;
    },
    tryNext: "run the eval on a run from its mode and read why it passes; the check must look at the thing that went wrong",
  },
  {
    says: "each eval passes on every run you labelled pass",
    test: async (d) => {
      const ev = await evals(d), pass = labels(d).filter((l) => l.label === "pass");
      if (!ev.length || !pass.length) return false;
      for (const e of ev) for (const l of pass) {
        const r = replayRun(l.run_id);
        const x = r ? runEval(e, r) : { pass: false, why: "no such run" };
        if (!x.pass) return say(`${e.mode} fails ${l.run_id} (${r?.invoice_id}), which you labelled pass: ${x.why ?? (x as any).error}`);
      }
      return true;
    },
    tryNext: "return null when the mode does not apply to the run; an eval that fails good runs gets switched off",
  },
  {
    says: "every eval passes on fresh runs of the healthy clerk, 3 fresh trials",
    test: async (d) => {
      const ev = await evals(d);
      if (!ev.length) return false;
      const trials = await healthyRuns();
      for (const [t, runs] of trials.entries()) for (const e of ev) for (const r of runs) {
        const x = runEval(e, r);
        if (!x.pass) return say(`Trial ${t + 1}: ${e.mode} fails a healthy run of ${r.invoice_id}: ${x.why ?? x.error}`);
      }
      return true;
    },
    tryNext: "a healthy run has the same shape as a replay run; guard reads of empty arrays and return null when the mode does not apply",
  },
] satisfies Rule[];

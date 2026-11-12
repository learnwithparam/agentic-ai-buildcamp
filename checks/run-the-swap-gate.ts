// gate.toml runs the current model and a candidate on the same invoices, evals and acceptance cases over 3 trials;
// gate.md states the decision and cost per outcome before and after, and both match the gate's own run within 2%.
import type { Rule } from "../scripts/verify";
import { TRAPS } from "./lib";
import { gate, gateMd, gateRun, near, say } from "../parts/04-operate/gate-lib";

export default [
  {
    says: "gate.toml names two recorded models, your evals, the invoices and at least 3 trials",
    test: (d) => { const g = gate(d); return g.problems.length === 0 || say(g.problems[0]); },
    tryNext: "fill in gate.toml: current, candidate, evals (the folder from write-an-eval-per-failure), invoices and trials = 3",
  },
  {
    says: "the gate runs the must-never traps and the acceptance cases from Design",
    test: (d) => {
      const c = gate(d).config;
      if (!c) return false;
      for (const id of [TRAPS.duplicate.invoice_id, TRAPS.above_rate.invoice_id])
        if (!c.invoices.includes(id)) return say(`invoices leaves out ${id}, a must-never trap. A gate that never meets the trap cannot see a model fall for it.`);
      return Boolean(c.acceptance) || say("gate.toml has no acceptance = path to your acceptance.yaml from turn-the-hire-into-tests.");
    },
    tryNext: "add the duplicate and the above-rate invoices to invoices, and point acceptance at your acceptance.yaml",
  },
  {
    says: "gate.md states the decision (allow or refuse) and cost per outcome before and after in USD",
    test: (d) => { const m = gateMd(d); return (m.decision !== null && m.before !== null && m.after !== null) || say("gate.md needs ## Decision with allow or refuse, and ## Cost per outcome with a before and an after line in USD."); },
    tryNext: "run the gate, then copy its decision and both cost per outcome numbers into gate.md",
  },
  {
    says: "gate.md matches the gate's own run: the same decision, cost per outcome within 2%",
    test: async (d) => {
      const p = gateRun(d), m = gateMd(d);
      if (!p || m.decision === null) return false;
      const r = await p;
      if (r.decision !== m.decision) return say(`gate.md says ${m.decision}; the gate says ${r.decision}${r.reasons[0] ? `: ${r.reasons[0]}` : ""}.`);
      if (!near(m.before, r.current.costPerOutcome)) return say(`gate.md says before USD ${m.before}; the gate measured USD ${r.current.costPerOutcome?.toFixed(6)} per outcome on ${r.current.model}.`);
      if (!near(m.after, r.candidate.costPerOutcome)) return say(`gate.md says after USD ${m.after}; the gate measured USD ${r.candidate.costPerOutcome?.toFixed(6)} per outcome on ${r.candidate.model}.`);
      return true;
    },
    tryNext: "copy the numbers from the gate's output, cost per outcome, not the price per call",
  },
] satisfies Rule[];

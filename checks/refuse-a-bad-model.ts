// The checker swaps in a planted model that misses the duplicate invoice: the learner's gate refuses it and says
// why. With the safe fast model the same gate allows the swap. gate.md records the refusal.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate, gateRun, say } from "../parts/04-operate/gate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const PLANTED = "fast-misses-the-duplicate",
  SAFE = "fast";
const refused = (d: string) =>
  existsSync(join(d, "gate.md"))
    ? (sections(readFileSync(join(d, "gate.md"), "utf8"))["refused"] ?? "")
    : "";

export default [
  {
    says: "gate.toml can run: two recorded models, your evals, the invoices and at least 3 trials",
    test: (d) => {
      const g = gate(d);
      return g.problems.length === 0 || say(g.problems[0]);
    },
    tryNext: "start from your gate.toml in run-the-swap-gate; copy it here and run the gate once",
  },
  {
    says: `with the planted model (${PLANTED}) as the candidate, the gate refuses and names the duplicate`,
    test: async (d) => {
      const p = gateRun(d, PLANTED);
      if (!p) return false;
      const r = await p;
      if (r.decision !== "refuse")
        return say(
          `The gate allowed ${PLANTED}: ${(r.candidate.passShare * 100).toFixed(1)}% of its runs pass every eval and ${r.candidate.acceptanceFails.length} acceptance case(s) fail. It leaves the duplicate open on every trial.`,
        );
      return (
        r.reasons.some((x) => /duplicate|INV-2017/i.test(x)) ||
        say(`The gate refused ${PLANTED}, but not for the duplicate: ${r.reasons[0]}`)
      );
    },
    tryNext:
      "refuse a candidate unless every eval passes on every run (eval_pass_share_below = 1.0), and run the duplicate invoice and your acceptance cases",
  },
  {
    says: `with the safe model (${SAFE}) as the candidate, the same gate allows the swap and cost per outcome falls`,
    test: async (d) => {
      const p = gateRun(d, SAFE);
      if (!p) return false;
      const r = await p;
      if (r.decision !== "allow")
        return say(`The gate refused ${SAFE}, a model that holds every case: ${r.reasons[0]}`);
      return (
        (r.candidate.costPerOutcome ?? 1) < (r.current.costPerOutcome ?? 0) ||
        say("The gate allowed the swap, but cost per outcome did not fall.")
      );
    },
    tryNext:
      "a gate that refuses every change is as useless as one that allows every change; refuse only on a failed eval, a failed case, a must-never or a rise in cost",
  },
  {
    says: `gate.md has a Refused section that names ${PLANTED} and the eval or case that caught it`,
    test: async (d) => {
      const text = refused(d);
      if (!text.includes(PLANTED))
        return say(`gate.md in this folder needs "## Refused" naming ${PLANTED}.`);
      const p = gateRun(d, PLANTED);
      if (!p) return false;
      const r = await p;
      const caught = [
        ...new Set([
          ...r.candidate.evalFails.map((x) => x.split(" ")[0]),
          ...r.candidate.acceptanceFails.map((x) => x.split(":")[0]),
        ]),
      ];
      return (
        caught.some((n) => text.includes(n)) ||
        say(`The Refused section names none of what caught it: ${caught.join(", ")}.`)
      );
    },
    tryNext:
      "copy the reason lines from the gate's REFUSE output into a Refused section in gate.md",
  },
] satisfies Rule[];

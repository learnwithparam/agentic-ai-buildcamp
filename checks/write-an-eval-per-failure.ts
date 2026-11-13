// evals/: one code check per failure mode in failure-modes.md (from count-the-failure-modes), each named after its
// mode, each running on every run of the replay set and answering null or a sentence.
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  find,
  loadEvals,
  loadReplaySet,
  readModes,
  runEval,
} from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";

const evals = (d: string) => loadEvals(existsSync(join(d, "evals")) ? join(d, "evals") : null);
const modes = (d: string) => readModes(find(d, "failure-modes.md", "count-the-failure-modes"));
const say = (m: string) => {
  console.log(`        ${m}`);
  return false;
};

export default [
  {
    says: "evals/ holds at least one eval: a .ts file whose default export is a function",
    test: async (d) => (await evals(d)).length > 0,
    tryNext:
      "copy evals/_example.ts to evals/<mode>.ts and change the check to the one failure mode it names",
  },
  {
    says: "every failure mode in failure-modes.md has its eval, evals/<mode>.ts",
    test: async (d) => {
      const have = new Set((await evals(d)).map((e) => e.mode));
      const ms = modes(d);
      if (!ms.length)
        return say("failure-modes.md has no modes. Finish count-the-failure-modes first.");
      const miss = ms.find((m) => !have.has(m.mode));
      return !miss || say(`No eval for ${miss.mode}. Write evals/${miss.mode}.ts.`);
    },
    tryNext: "name each eval file exactly like its mode in failure-modes.md, one file per mode",
  },
  {
    says: "every eval runs on all 60 runs of the replay set without an error, and answers null or a sentence",
    test: async (d) => {
      const ev = await evals(d);
      if (!ev.length) return false;
      for (const e of ev)
        for (const r of loadReplaySet()) {
          const x = runEval(e, r);
          if (x.error) return say(`${e.mode} threw on ${r.run_id} (${r.invoice_id}): ${x.error}`);
          if (!x.pass && (typeof x.why !== "string" || !x.why.trim()))
            return say(
              `${e.mode} on ${r.run_id} returned something other than null or a sentence.`,
            );
        }
      return true;
    },
    tryNext:
      "guard every read: a run may have no dispute, no payment and no approval; return null when the mode does not apply",
  },
] satisfies Rule[];

// labels.csv: at least 30 of the 60 replay runs labelled pass or fail with a note, every run that did not end done
// among them, and every label agrees with the ledger. The truth is the ledger and the evidence, never the reply.
import type { Rule } from "../scripts/verify";
import { loadReplaySet, readLabels, replayRun, rightOutcome } from "../parts/04-operate/operate-lib";

import { existsSync } from "node:fs";
import { join } from "node:path";
// This step's own labels.csv only; later steps read it through find().
const own = (d: string) => readLabels(existsSync(join(d, "labels.csv")) ? join(d, "labels.csv") : null);
const labels = (d: string) => own(d).labels;
const say = (m: string) => { console.log(`        ${m}`); return false; };

export default [
  {
    says: "labels.csv has the columns run_id, label and note",
    test: (d) => ["run_id", "label", "note"].every((c) => own(d).header.includes(c)),
    tryNext: "keep the first line of labels.csv as run_id,label,note and add one line per run you read",
  },
  {
    says: "at least 30 runs are labelled, each a run in the replay set, none twice",
    test: (d) => {
      const ls = labels(d), seen = new Set<string>();
      for (const l of ls) {
        if (!replayRun(l.run_id)) return say(`${l.run_id || "(empty)"} is not a run in the replay set. Copy run ids from the trace viewer.`);
        if (seen.has(l.run_id)) return say(`${l.run_id} is labelled twice.`);
        seen.add(l.run_id);
      }
      return ls.length >= 30 || say(`${ls.length} runs labelled; label at least 30.`);
    },
    tryNext: "open the trace viewer, read each run's spans and the ledger line, and add a row per run until you have 30",
  },
  {
    says: "every label is pass or fail, with a note of at least three words",
    test: (d) => labels(d).length > 0 && labels(d).every((l) =>
      (["pass", "fail"].includes(l.label) || say(`${l.run_id} is labelled "${l.label}"; use pass or fail.`)) &&
      (l.note.split(/\s+/).filter(Boolean).length >= 3 || say(`${l.run_id} has no note. Say what you saw in a few words.`))),
    tryNext: "write pass or fail, then a short note on what the ledger shows and why",
  },
  {
    says: "every run that did not end done is labelled",
    test: (d) => {
      const have = new Set(labels(d).map((l) => l.run_id));
      const miss = loadReplaySet().filter((r) => r.status !== "done" && !have.has(r.run_id));
      return miss.length === 0 || say(`${miss.length} runs that did not end done are not labelled, first ${miss[0].run_id} (${miss[0].invoice_id}, ${miss[0].status}).`);
    },
    tryNext: "read the runs that ended stopped, failed or waiting first; that is where the failures are",
  },
  {
    says: "every label agrees with the ledger: pass only where the outcome is right, fail where it is not",
    test: (d) => labels(d).length > 0 && labels(d).every((l) => {
      const r = replayRun(l.run_id);
      if (!r) return false;
      const right = rightOutcome(r);
      if (l.label === "pass" && !right) return say(`${l.run_id} (${r.invoice_id}) is labelled pass, but the ledger does not hold what the evidence allows. The employee said "${r.status}".`);
      if (l.label === "fail" && right) return say(`${l.run_id} (${r.invoice_id}) is labelled fail, but the employee did the right thing: ${r.status === "waiting_for_human" ? "it waits for the person who may approve" : r.status === "stopped" ? "it refused an order hidden in a document" : "the ledger agrees with the evidence"}.`);
      return true;
    }),
    tryNext: "label by what the ledger shows against the evidence, not by the status the employee reports",
  },
] satisfies Rule[];

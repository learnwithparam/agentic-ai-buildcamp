// failure-modes.md: the runs labelled fail, grouped into modes whose counts add up. Labels come from
// label-the-traces (this folder's labels.csv, else that step's folder of the same kind).
import type { Rule } from "../scripts/verify";
import { find, readLabels, readModes, replayRun } from "../parts/04-operate/operate-lib";

const modes = (d: string) => readModes(find(d, "failure-modes.md", "count-the-failure-modes"));
const fails = (d: string) => readLabels(find(d, "labels.csv", "label-the-traces")).labels.filter((l) => l.label === "fail").map((l) => l.run_id);
const passes = (d: string) => new Set(readLabels(find(d, "labels.csv", "label-the-traces")).labels.filter((l) => l.label === "pass").map((l) => l.run_id));
const say = (m: string) => { console.log(`        ${m}`); return false; };

export default [
  {
    says: "failure-modes.md has a table with Mode, Count and Runs columns and at least two modes",
    test: (d) => modes(d).length >= 2 || say(modes(d).length ? "One mode for every failure tells you nothing to fix. Split it by what went wrong first." : "The table has no modes yet."),
    tryNext: "fill the table under the heading: one row per way the clerk failed, with its count and its run ids",
  },
  {
    says: "every mode is named verb-thing in lower case, and its count equals the runs it lists",
    test: (d) => modes(d).length > 0 && modes(d).every((m) =>
      (/^[a-z]+(-[a-z0-9]+)+$/.test(m.mode) || say(`"${m.mode}" is not verb-thing, such as missed-the-duplicate.`)) &&
      (m.count === m.runs.length || say(`${m.mode} says ${m.count} but lists ${m.runs.length} run(s).`))),
    tryNext: "name each mode for what went wrong, like missed-the-duplicate, and count the run ids you listed",
  },
  {
    says: "the counts add up to the runs you labelled fail, each in exactly one mode",
    test: (d) => {
      const f = fails(d), listed = modes(d).flatMap((m) => m.runs);
      if (!f.length) return say("No runs are labelled fail in labels.csv. Finish label-the-traces first.");
      const total = modes(d).reduce((a, m) => a + m.count, 0);
      if (total !== f.length) return say(`The counts add up to ${total}; you labelled ${f.length} runs fail.`);
      const twice = listed.find((r, i) => listed.indexOf(r) !== i);
      if (twice) return say(`${twice} is in two modes. Give each failed run one mode, the first thing that went wrong.`);
      const miss = f.find((r) => !listed.includes(r));
      if (miss) return say(`${miss} is labelled fail but is in no mode.`);
      const p = passes(d), wrong = listed.find((r) => p.has(r) || !f.includes(r));
      return !wrong || say(`${wrong} is in a mode but you did not label it fail.`);
    },
    tryNext: "list every run you labelled fail in exactly one mode, and nothing else",
  },
  {
    says: "each mode holds runs that failed the same way: all failed, or all stopped",
    test: (d) => modes(d).length > 0 && modes(d).every((m) => {
      const ends = new Set(m.runs.map((r) => replayRun(r)?.status ?? "unknown"));
      return ends.size <= 1 || say(`${m.mode} mixes runs that ended ${[...ends].join(" and ")}. A stopped draft and a ledger error need different fixes.`);
    }),
    tryNext: "split a mode whose runs ended differently: a ledger error and a wrong draft need different fixes and different evals",
  },
  {
    says: "the modes are listed largest first",
    test: (d) => modes(d).every((m, i, a) => i === 0 || a[i - 1].count >= m.count) || say("Sort the table by count, largest first: fix the biggest mode first."),
    tryNext: "sort the rows by count, largest first, so the biggest failure is the first thing a reader sees",
  },
] satisfies Rule[];

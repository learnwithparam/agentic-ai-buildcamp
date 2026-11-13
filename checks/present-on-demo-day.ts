// demo.md: the hire letter, before and after, the scorecard, cost per outcome before and after that matches the
// swap gate's decision, one failure fixed with its eval, a recording link, and the peers' yes or no answers.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gateMd, near } from "../parts/04-operate/gate-lib";
import { evalsDir, find, loadEvals, readModes } from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const demo = (d: string) =>
  existsSync(join(d, "demo.md")) ? sections(readFileSync(join(d, "demo.md"), "utf8")) : {};
const NEED = [
  "hire letter",
  "before and after",
  "scorecard",
  "cost per outcome",
  "one failure fixed",
  "recording",
  "demo rubric",
];
const say = (m: string) => {
  console.log(`        ${m}`);
  return false;
};
const usdAfter = (text: string, w: string) => {
  const m = text.match(new RegExp(`${w}[^\\n]*?USD\\s*([0-9]*\\.?[0-9]+)`, "i"));
  return m ? Number(m[1]) : null;
};

export default [
  {
    says: "demo.md has Hire letter, Before and after, Scorecard, Cost per outcome, One failure fixed, Recording and Demo rubric",
    test: (d) => {
      const s = demo(d);
      const miss = NEED.find(
        (n) => !(s[n] ?? "").trim() || /^(write|paste|link|name)\b.*\.\.\.$/im.test(s[n]),
      );
      return (
        !miss || say(`demo.md has no "## ${miss[0].toUpperCase() + miss.slice(1)}" with content.`)
      );
    },
    tryNext: "fill every section in demo.md; each one is a slide in your five minutes",
  },
  {
    says: "Recording links to the recording over https",
    test: (d) =>
      /https:\/\/\S+/.test(demo(d)["recording"] ?? "") || say("Recording has no https link."),
    tryNext:
      "upload the five-minute recording where your peers can open it and paste the https link",
  },
  {
    says: "Scorecard holds the pasted line that says the Operate part is done",
    test: (d) =>
      /Part operate is done: (\d+)\/\1 steps pass/.test(demo(d)["scorecard"] ?? "") ||
      say("Scorecard has no `Part operate is done: 9/9 steps pass.` line."),
    tryNext:
      "run bun run verify part operate (and the other parts) and paste the tables into Scorecard",
  },
  {
    says: "Cost per outcome before and after match your swap gate's decision within 2%",
    test: (d) => {
      const s = demo(d)["cost per outcome"] ?? "",
        g2 = gateMd(d);
      const b = usdAfter(s, "before"),
        a = usdAfter(s, "after");
      if (g2.before === null)
        return say("No gate.md from run-the-swap-gate to compare with. Finish that step first.");
      if (!near(b, g2.before))
        return say(`demo.md says before USD ${b}; your gate measured USD ${g2.before}.`);
      return (
        near(a, g2.after) || say(`demo.md says after USD ${a}; your gate measured USD ${g2.after}.`)
      );
    },
    tryNext:
      "copy both numbers from gate.md in run-the-swap-gate: a before line and an after line, each with USD",
  },
  {
    says: "One failure fixed names a failure mode from failure-modes.md and the eval that catches it",
    test: async (d) => {
      const s = demo(d)["one failure fixed"] ?? "";
      const modes = readModes(find(d, "failure-modes.md", "count-the-failure-modes")).map(
        (m) => m.mode,
      );
      const evals = (await loadEvals(evalsDir(d))).map((e) => e.mode);
      const m = modes.find((x) => s.includes(x));
      if (!m)
        return say(
          `One failure fixed names none of your failure modes (${modes.join(", ") || "none found"}).`,
        );
      return evals.includes(m) || say(`${m} has no eval in your evals folder.`);
    },
    tryNext:
      "name the mode, its count before and after, the eval file that catches it, and what you changed",
  },
  {
    says: "Demo rubric: two peers answer the five demo questions yes or no",
    test: (d) => {
      const rows = (demo(d)["demo rubric"] ?? "")
        .split("\n")
        .filter((l) => l.trim().startsWith("|"))
        .slice(2)
        .map((l) =>
          l
            .trim()
            .replace(/^\||\|$/g, "")
            .split("|")
            .map((c) => c.trim().toLowerCase()),
        );
      if (rows.length < 5)
        return say(`Demo rubric has ${rows.length} question(s); it needs the five.`);
      return (
        rows.every((r) => r.length >= 3 && r.slice(1, 3).every((c) => c === "yes" || c === "no")) ||
        say("Every answer is yes or no, one column per peer.")
      );
    },
    tryNext: "ask two peers to watch the recording and answer each question with yes or no",
  },
] satisfies Rule[];

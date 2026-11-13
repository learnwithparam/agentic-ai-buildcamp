// The ledger answers 503 for a while. The employee pauses, shows one incident card on GET /board, and resumes
// every job after, paying each once. runbook.md has Detect, Stop, Tell, Fix and Learn. 3 fresh trials.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { drill } from "../parts/04-operate/drill";
import { evalsDir, loadEvals } from "../parts/04-operate/operate-lib";
import type { Rule } from "../scripts/verify";
import { sections } from "./design-lib";

const say = (m: string) => {
  console.log(`        ${m}`);
  return false;
};
const aspect = (k: "pauses" | "oneCard" | "resumes") => async (d: string) => {
  const r = await drill(d);
  if (r.error) return say(r.error);
  return r[k] === null || say(r[k]!);
};
const runbook = (d: string) =>
  existsSync(join(d, "runbook.md")) ? sections(readFileSync(join(d, "runbook.md"), "utf8")) : {};
const PARTS = ["detect", "stop", "tell", "fix", "learn"];
const PEOPLE = /\b(Lena|Ravi|finance lead|AP clerk)\b/i;

export default [
  {
    says: "while the ledger is down, no job ends and the employee does not hammer the ledger",
    test: aspect("pauses"),
    tryNext:
      "on a 503 from a tool, pause the job and probe the ledger once a beat; do not fail the job and do not retry in a tight loop",
  },
  {
    says: "GET /board shows one open incident card during the outage, closed after",
    test: aspect("oneCard"),
    tryNext:
      "keep one incident for the outage on the board, list the paused jobs on it, and close it when the ledger answers",
  },
  {
    says: "after the outage every paused job resumes and the ledger shows each invoice paid once",
    test: aspect("resumes"),
    tryNext:
      "resume from the step that was paused with the same Idempotency-Key, then check the ledger before you report done",
  },
  {
    says: "runbook.md has Detect, Stop, Tell, Fix and Learn, each with at least one line",
    test: (d) => {
      const s = runbook(d);
      const miss = PARTS.find((p) => !(s[p] ?? "").trim());
      return (
        !miss ||
        say(`runbook.md has no ${miss[0].toUpperCase() + miss.slice(1)} section, or it is empty.`)
      );
    },
    tryNext:
      "write five sections in runbook.md: how you notice, how you stop the damage, who you tell, how you fix, what you add so it is caught next time",
  },
  {
    says: "Tell names the person to tell, and Learn names one of your evals",
    test: async (d) => {
      const s = runbook(d);
      if (!PEOPLE.test(s["tell"] ?? ""))
        return say(
          "Tell names nobody. Say who hears first: the finance lead (Lena) or the AP clerk (Ravi).",
        );
      const ev = (await loadEvals(evalsDir(d))).map((e) => e.mode);
      return (
        ev.some((m) => (s["learn"] ?? "").includes(m)) ||
        say(
          `Learn names none of your evals (${ev.join(", ") || "none found"}). Name the eval that catches this next time.`,
        )
      );
    },
    tryNext:
      "in Tell name Lena or Ravi; in Learn name the eval file, such as failed-on-a-ledger-error",
  },
] satisfies Rule[];

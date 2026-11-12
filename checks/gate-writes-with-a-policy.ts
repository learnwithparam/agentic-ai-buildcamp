// gate-writes-with-a-policy: the limits live in policy.yaml, outside the model and the prompt. The checker hands the
// employee a copy of its own policy.yaml through POLICY_FILE with one limit changed, and reads the ledger: the same
// invoice pays or waits as the file says. Every write in the trace comes after a gate span.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedRule,
  expect,
  fileRule,
  passKWith,
  runs,
  sendJob,
  tmp,
  writeFile,
} from "./deploy-lib";
import {
  contract,
  findEmployeeDir,
  paymentsFor,
  readAll,
  type Span,
  spansNamed,
  startEmployee,
  TRAPS,
} from "./lib";

const OVER = TRAPS.over_ravi_limit.invoice_id; // USD 6,200
const SMALL = "INV-2041"; // USD 1,910, clean

function policyWith(empDir: string, limit: number) {
  const p: any = Bun.YAML.parse(readFileSync(join(empDir, "policy.yaml"), "utf8"));
  p.limits = { ...(p.limits ?? {}), pay_usd_without_approval: limit };
  return writeFile(tmp("policy"), "policy.yaml", JSON.stringify(p, null, 2)); // JSON is valid YAML
}

// Every span that writes (x.side_effect = write) has a gate span in the same run that ended before it started.
function writesWithoutGate(spans: Span[]) {
  const bad: string[] = [];
  for (const r of runs(spans)) {
    const gates = spansNamed(r.spans, "x.policy_gate");
    for (const w of r.spans.filter(
      (s) => s.name === "execute_tool" && s.attributes["x.side_effect"] === "write",
    ))
      if (!gates.some((g) => g.end_time <= w.start_time))
        bad.push(String(w.attributes["gen_ai.tool.name"]));
  }
  return bad;
}

const limitInTheFile = (dir: string) => {
  let empDir = "";
  try {
    empDir = findEmployeeDir(dir);
  } catch {}
  return passKWith(
    dir,
    () =>
      existsSync(join(empDir, "policy.yaml")) ? { POLICY_FILE: policyWith(empDir, 7000) } : {},
    async (c) => {
      expect(
        c.env.POLICY_FILE,
        `There is no policy.yaml next to employee.toml, so the checker has no limit to change.`,
      );
      // Limit raised to USD 7,000: the USD 6,200 invoice pays with no approval.
      const a = await sendJob(c, OVER);
      const sa = await c.api.waitJob(a.job_id, { ms: 15_000 });
      const pa = paymentsFor(c.world, OVER).length;
      expect(
        pa === 1 && sa.status === "done",
        `With pay_usd_without_approval: 7000 in POLICY_FILE, ${OVER} (USD 6,200) should pay once with no approval. The ledger shows ${pa} payments and the job is "${sa.status}". Read the limit from POLICY_FILE, not from code or the prompt.`,
      );
      const ungated = writesWithoutGate(readAll(c.emp));
      expect(
        ungated.length === 0,
        `The trace shows ${ungated[0]} with no x.policy_gate span before it. Run the gate before every write and log it.`,
      );

      // Limit lowered to USD 1,000 in a new process: a clean USD 1,910 invoice waits for Lena.
      await c.emp.stop();
      c.world.reset();
      const low = await startEmployee(c.emp.dir, c.world.url, {
        env: { POLICY_FILE: policyWith(empDir, 1000) },
      });
      try {
        const api = contract(low);
        const jobId = c.jobId(SMALL);
        await api.startJob({
          job_id: jobId,
          tenant: "kaas-freight",
          trigger: { kind: "person", by: "ravi" },
          input: { invoice_id: SMALL },
        });
        const sb = await api.waitJob(jobId, { ms: 15_000 });
        expect(
          paymentsFor(c.world, SMALL).length === 0,
          `With pay_usd_without_approval: 1000 in POLICY_FILE, ${SMALL} (USD 1,910) was paid with no approval. Read the limit from the file on start.`,
        );
        expect(
          sb.status === "waiting_for_human",
          `With pay_usd_without_approval: 1000, ${SMALL} (USD 1,910) must wait for approval. Your employee says "${sb.status}".`,
        );
      } finally {
        await low.stop();
      }
    },
  );
};

export default [
  fileRule(
    "policy.yaml sits next to employee.toml with a payment limit and named rules",
    "write policy.yaml with limits.pay_usd_without_approval and a rules list where each rule has an id and says",
    (empDir) => {
      const f = join(empDir, "policy.yaml");
      if (!existsSync(f)) return `There is no policy.yaml in ${empDir}.`;
      let p: any;
      try {
        p = Bun.YAML.parse(readFileSync(f, "utf8"));
      } catch (e) {
        return `policy.yaml does not parse: ${(e as Error).message}`;
      }
      if (typeof p?.limits?.pay_usd_without_approval !== "number")
        return "policy.yaml has no number at limits.pay_usd_without_approval.";
      if (!Array.isArray(p.rules) || p.rules.length === 0) return "policy.yaml has no rules list.";
      const bad = p.rules.find((r: any) => !r?.id || !r?.says);
      return bad ? `A rule in policy.yaml has no id or no says: ${JSON.stringify(bad)}.` : null;
    },
  ),
  cachedRule(
    "policy",
    "a limit changed in policy.yaml changes what the employee pays, with no prompt change, and every write passes the gate first",
    "load policy.yaml (or POLICY_FILE when it is set) on start, check each draft against it in code before the write, and log an x.policy_gate span",
    limitInTheFile,
  ),
];

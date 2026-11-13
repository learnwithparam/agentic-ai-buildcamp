// gate-writes-with-a-policy: the limits live in policy.yaml, outside the model and the prompt. The
// checker hands the employee a copy of its own policy.yaml through POLICY_FILE with one limit
// changed, and reads the ledger: the same invoice pays or waits as the file says. Every write in
// the trace comes after a gate span.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  cachedRule,
  type DeployContext,
  expect,
  fileRule,
  passTrialsWith,
  runs,
  sendJob,
  temporaryFolder,
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

const OVER_RAVI_LIMIT = TRAPS.over_ravi_limit.invoice_id; // USD 6,200
const SMALL_CLEAN_INVOICE = "INV-2041"; // USD 1,910, clean

type PolicyRule = { id?: string; says?: string };
type Policy = {
  limits?: { pay_usd_without_approval?: unknown };
  rules?: PolicyRule[];
};

function readPolicy(file: string): Policy {
  return Bun.YAML.parse(readFileSync(file, "utf8")) as Policy;
}

// A copy of the employee's own policy.yaml with the payment limit changed.
function policyWith(employeeDir: string, limit: number): string {
  const policy = readPolicy(join(employeeDir, "policy.yaml"));
  policy.limits = { ...(policy.limits ?? {}), pay_usd_without_approval: limit };
  // JSON is valid YAML, so the copy can be written as JSON.
  return writeFile(temporaryFolder("policy"), "policy.yaml", JSON.stringify(policy, null, 2));
}

// Every span that writes (x.side_effect = write) has a gate span in the same run that ended
// before it started. Returns the tool names of the writes that had no gate.
function writesWithoutGate(spans: Span[]): string[] {
  const ungated: string[] = [];
  for (const run of runs(spans)) {
    const gates = spansNamed(run.spans, "x.policy_gate");
    const writes = run.spans.filter(
      (span) => span.name === "execute_tool" && span.attributes["x.side_effect"] === "write",
    );
    for (const write of writes) {
      const gatedFirst = gates.some((gate) => gate.end_time <= write.start_time);
      if (!gatedFirst) ungated.push(String(write.attributes["gen_ai.tool.name"]));
    }
  }
  return ungated;
}

// Limit raised to USD 7,000: the USD 6,200 invoice pays with no approval, through the gate.
async function raisedLimitPays(context: DeployContext) {
  const job = await sendJob(context, OVER_RAVI_LIMIT);
  const state = await context.api.waitJob(job.job_id, { ms: 15_000 });
  const paymentCount = paymentsFor(context.world, OVER_RAVI_LIMIT).length;
  expect(
    paymentCount === 1 && state.status === "done",
    `With pay_usd_without_approval: 7000 in POLICY_FILE, ${OVER_RAVI_LIMIT} (USD 6,200) ` +
      `should pay once with no approval. The ledger shows ${paymentCount} payments and the job ` +
      `is "${state.status}". Read the limit from POLICY_FILE, not from code or the prompt.`,
  );
  const ungated = writesWithoutGate(readAll(context.emp));
  expect(
    ungated.length === 0,
    `The trace shows ${ungated[0]} with no x.policy_gate span before it. ` +
      "Run the gate before every write and log it.",
  );
}

// Limit lowered to USD 1,000 in a new process: a clean USD 1,910 invoice waits for Lena.
async function loweredLimitWaits(context: DeployContext, employeeDir: string) {
  await context.emp.stop();
  context.world.reset();
  const policyFile = policyWith(employeeDir, 1000);
  const lowLimitEmployee = await startEmployee(context.emp.dir, context.world.url, {
    env: Object.fromEntries([["POLICY_FILE", policyFile]]),
  });
  try {
    const api = contract(lowLimitEmployee);
    const jobId = context.jobId(SMALL_CLEAN_INVOICE);
    await api.startJob({
      job_id: jobId,
      tenant: "kaas-freight",
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: SMALL_CLEAN_INVOICE },
    });
    const state = await api.waitJob(jobId, { ms: 15_000 });
    expect(
      paymentsFor(context.world, SMALL_CLEAN_INVOICE).length === 0,
      `With pay_usd_without_approval: 1000 in POLICY_FILE, ${SMALL_CLEAN_INVOICE} (USD 1,910) ` +
        "was paid with no approval. Read the limit from the file on start.",
    );
    expect(
      state.status === "waiting_for_human",
      `With pay_usd_without_approval: 1000, ${SMALL_CLEAN_INVOICE} (USD 1,910) must wait for ` +
        `approval. Your employee says "${state.status}".`,
    );
  } finally {
    await lowLimitEmployee.stop();
  }
}

// The first trial's employee gets a policy with the limit raised to USD 7,000.
function raisedLimitEnvironment(employeeDir: string): Record<string, string> {
  if (!existsSync(join(employeeDir, "policy.yaml"))) return {};
  return Object.fromEntries([["POLICY_FILE", policyWith(employeeDir, 7000)]]);
}

function limitInTheFile(dir: string) {
  let employeeDir = "";
  try {
    employeeDir = findEmployeeDir(dir);
  } catch {
    // passTrialsWith finds the same folder again and reports the problem itself.
  }
  return passTrialsWith(
    dir,
    () => raisedLimitEnvironment(employeeDir),
    async (context) => {
      expect(
        context.env.POLICY_FILE,
        "There is no policy.yaml next to employee.toml, so the checker has no limit to change.",
      );
      await raisedLimitPays(context);
      await loweredLimitWaits(context, employeeDir);
    },
  );
}

// What is wrong with the employee's policy.yaml, or null when it has a limit and named rules.
function policyProblem(employeeDir: string): string | null {
  const file = join(employeeDir, "policy.yaml");
  if (!existsSync(file)) return `There is no policy.yaml in ${employeeDir}.`;
  let policy: Policy;
  try {
    policy = readPolicy(file);
  } catch (error) {
    return `policy.yaml does not parse: ${(error as Error).message}`;
  }
  if (typeof policy?.limits?.pay_usd_without_approval !== "number") {
    return "policy.yaml has no number at limits.pay_usd_without_approval.";
  }
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    return "policy.yaml has no rules list.";
  }
  const unnamed = policy.rules.find((rule) => !rule?.id || !rule?.says);
  if (unnamed) return `A rule in policy.yaml has no id or no says: ${JSON.stringify(unnamed)}.`;
  return null;
}

export default [
  fileRule(
    "policy.yaml sits next to employee.toml with a payment limit and named rules",
    "write policy.yaml with limits.pay_usd_without_approval " +
      "and a rules list where each rule has an id and says",
    policyProblem,
  ),
  cachedRule(
    "policy",
    "a limit changed in policy.yaml changes what the employee pays, with no prompt change, " +
      "and every write passes the gate first",
    "load policy.yaml (or POLICY_FILE when it is set) on start, " +
      "check each draft against it in code before the write, and log an x.policy_gate span",
    limitInTheFile,
  ),
];

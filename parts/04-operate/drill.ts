// The incident drill: the ledger answers 503 for a while (sped up), and the checker watches
// the employee through a counting proxy in front of the world.
// Read from the world's ledger, the proxy's count and GET /board.

import { contract } from "../../checks/lib/contract";
import {
  CheckProblem,
  findEmployeeDir,
  type Running,
  startEmployee,
} from "../../checks/lib/employee";
import { TRIALS_PER_CHECK } from "../../checks/lib/trials";
import { checkerWorld, paymentsFor, TRAPS } from "../../checks/lib/world";

export const OUTAGE_MS = Number(process.env.DRILL_OUTAGE_MS ?? 1500);
export const MAX_CALLS_WHILE_DOWN = 60;

// What the drill found: null where the employee behaved, or the sentence that says what went wrong.
export type Drill = {
  error: string | null;
  pauses: string | null;
  oneCard: string | null;
  resumes: string | null;
};

type Incident = { status?: string; closed_at?: string | null };
type Employee = ReturnType<typeof contract>;
type CheckerWorld = ReturnType<typeof checkerWorld>;

// One drill run, everything a step of the drill needs.
type Trial = {
  employee: Employee;
  world: CheckerWorld;
  jobIds: Map<string, string>;
  found: Drill;
  tag: (message: string) => string;
};

// The drill runs once per employee folder, however many checks read it.
const drillsByFolder = new Map<string, Promise<Drill>>();
export const drill = (folder: string) => {
  let drillRun = drillsByFolder.get(folder);
  if (!drillRun) {
    drillRun = runDrill(folder);
    drillsByFolder.set(folder, drillRun);
  }
  return drillRun;
};

// Remembers the first problem of each kind; later problems of the same kind are left out.
function note(found: Drill, kind: "pauses" | "oneCard" | "resumes", message: string) {
  if (!found[kind]) found[kind] = message;
}

const isOpen = (incident: Incident) => incident.status === "open" || !incident.closed_at;
const isStillOpen = (incident: Incident) =>
  incident.status === "open" || (incident.status === undefined && !incident.closed_at);

// A proxy in front of the world that counts tool calls while the ledger is down.
function countingProxy(world: CheckerWorld) {
  const counter = { down: false, calls: 0 };
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (counter.down && url.pathname.startsWith("/tools/")) counter.calls++;
      let body: ArrayBuffer | undefined;
      if (request.method !== "GET") body = await request.arrayBuffer();
      return fetch(world.url + url.pathname + url.search, {
        method: request.method,
        headers: request.headers,
        body,
      });
    },
  });
  return { server, counter };
}

// Four clean invoices for this trial, a different four each trial.
function invoicesForTrial(trialNumber: number): string[] {
  const clean: string[] = TRAPS.clean.invoice_ids;
  const offsets = [0, 1, 2, 3];
  return offsets.map((offset) => clean[(trialNumber * 4 + offset + 20) % clean.length]);
}

async function startJobs(trial: Trial) {
  for (const [invoiceId, jobId] of trial.jobIds) {
    await trial.employee.startJob({
      job_id: jobId,
      tenant: "kaas-freight",
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: invoiceId },
    });
  }
}

// While the ledger is down, each job waits instead of ending.
async function checkJobsPause(trial: Trial) {
  const jobs = [...trial.jobIds];
  const statuses = await Promise.all(
    jobs.map(async ([invoiceId, jobId]) => {
      const status: string | undefined = (await trial.employee.readJob(jobId)).body?.status;
      return { invoiceId, status };
    }),
  );
  const ended = statuses.find(
    ({ status }) => status && status !== "working" && status !== "waiting_for_human",
  );
  if (!ended) return;
  const message =
    `while the ledger was down, the job for ${ended.invoiceId} ended "${ended.status}". ` +
    "Pause the job and carry on when the ledger answers.";
  note(trial.found, "pauses", trial.tag(message));
}

async function incidentsOnBoard(employee: Employee): Promise<Incident[]> {
  const board = (await employee.board()).body ?? {};
  if (Array.isArray(board.incidents)) return board.incidents;
  return [];
}

// While the ledger is down, the board shows exactly one open incident card.
async function checkOneOpenCard(trial: Trial) {
  const openIncidents = (await incidentsOnBoard(trial.employee)).filter(isOpen);
  if (openIncidents.length === 1) return;
  const message =
    `while the ledger was down, GET /board shows ${openIncidents.length} open incident(s). ` +
    'Show one card for the outage, with "status": "open", not one per job and not none.';
  note(trial.found, "oneCard", trial.tag(message));
}

// Once the ledger is back, every job finishes and pays its invoice once.
async function checkJobsResume(trial: Trial) {
  for (const [invoiceId, jobId] of trial.jobIds) {
    const job = await trial.employee.waitJob(jobId, { ms: 15_000 });
    const paymentCount = paymentsFor(trial.world, invoiceId).length;
    if (job.status !== "done" || paymentCount !== 1) {
      const message =
        `after the ledger came back, ${invoiceId} is "${job.status}" with ${paymentCount} ` +
        "payment(s). Resume each paused job and pay it once.";
      note(trial.found, "resumes", trial.tag(message));
    }
  }
}

// Once the ledger is back, the incident card is closed.
async function checkCardCloses(trial: Trial) {
  const incidents = ((await trial.employee.board()).body?.incidents ?? []) as Incident[];
  if (incidents.some(isStillOpen)) {
    const message =
      "the ledger is back, but the incident on the board is still open. " +
      "Close it when the jobs resume.";
    note(trial.found, "oneCard", trial.tag(message));
  }
  if (incidents.length === 0) {
    const message =
      'GET /board has no incidents list. Add "incidents": [{"incident_id", "summary", "status"}].';
    note(trial.found, "oneCard", trial.tag(message));
  }
}

// One trial: take the ledger down, start four jobs, watch, bring the ledger back, watch again.
async function runTrial(trial: Trial, counter: { down: boolean; calls: number }) {
  trial.world.setFaults({ outage: true });
  counter.down = true;
  await startJobs(trial);
  await Bun.sleep(OUTAGE_MS * 0.6);
  await checkJobsPause(trial);
  await checkOneOpenCard(trial);
  await Bun.sleep(OUTAGE_MS * 0.4);
  trial.world.setFaults({ outage: false });
  counter.down = false;
  if (counter.calls > MAX_CALLS_WHILE_DOWN) {
    const message =
      `your employee called the ledger ${counter.calls} times while it was down. ` +
      "Probe it once a beat, not once per job per try.";
    note(trial.found, "pauses", trial.tag(message));
  }
  await checkJobsResume(trial);
  await checkCardCloses(trial);
}

// Each job id is new for every trial, so trials never meet each other's jobs.
function jobIdsFor(invoiceIds: string[]): Map<string, string> {
  const nonce = Math.random().toString(36).slice(2, 7);
  return new Map(invoiceIds.map((invoiceId) => [invoiceId, `drill-${nonce}-${invoiceId}`]));
}

function trialTag(trialNumber: number) {
  return (message: string) => {
    if (TRIALS_PER_CHECK > 1) return `Trial ${trialNumber} of ${TRIALS_PER_CHECK}: ${message}`;
    return message;
  };
}

async function runDrill(folder: string): Promise<Drill> {
  const found: Drill = { error: null, pauses: null, oneCard: null, resumes: null };
  let employeeFolder: string;
  try {
    employeeFolder = findEmployeeDir(folder);
  } catch (error) {
    return { ...found, error: (error as Error).message };
  }
  for (let trialNumber = 1; trialNumber <= TRIALS_PER_CHECK; trialNumber++) {
    const world = checkerWorld();
    const proxy = countingProxy(world);
    const tag = trialTag(trialNumber);
    let running: Running | null = null;
    try {
      running = await startEmployee(employeeFolder, `http://localhost:${proxy.server.port}`);
      const employee = contract(running);
      const jobIds = jobIdsFor(invoicesForTrial(trialNumber));
      await runTrial({ employee, world, jobIds, found, tag }, proxy.counter);
    } catch (error) {
      let message = `the check hit an error: ${(error as Error).message}`;
      if (error instanceof CheckProblem) message = error.message;
      found.error = tag(message);
      return found;
    } finally {
      await running?.stop();
      proxy.server.stop(true);
      world.stop();
    }
  }
  return found;
}

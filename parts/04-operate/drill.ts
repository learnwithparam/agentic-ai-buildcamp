// The incident drill: the ledger answers 503 for a while (sped up), and the checker watches the employee through a
// counting proxy in front of the world. Read from the world's ledger, the proxy's count and GET /board.

import { contract } from "../../checks/lib/contract";
import {
  CheckProblem,
  findEmployeeDir,
  type Running,
  startEmployee,
} from "../../checks/lib/employee";
import { K } from "../../checks/lib/trials";
import { checkerWorld, paymentsFor, TRAPS } from "../../checks/lib/world";

export const OUTAGE_MS = Number(process.env.DRILL_OUTAGE_MS ?? 1500);
export const MAX_CALLS_WHILE_DOWN = 60;
export type Drill = {
  error: string | null;
  pauses: string | null;
  oneCard: string | null;
  resumes: string | null;
};

const cache = new Map<string, Promise<Drill>>();
export const drill = (dir: string) => {
  if (!cache.has(dir)) cache.set(dir, run(dir));
  return cache.get(dir)!;
};

async function run(dir: string): Promise<Drill> {
  const out: Drill = { error: null, pauses: null, oneCard: null, resumes: null };
  let empDir: string;
  try {
    empDir = findEmployeeDir(dir);
  } catch (e) {
    return { ...out, error: (e as Error).message };
  }
  const clean: string[] = TRAPS.clean.invoice_ids;
  for (let trial = 1; trial <= K; trial++) {
    const world = checkerWorld();
    let down = false,
      calls = 0;
    const proxy = Bun.serve({
      port: 0,
      idleTimeout: 0,
      async fetch(req) {
        const u = new URL(req.url);
        if (down && u.pathname.startsWith("/tools/")) calls++;
        return fetch(world.url + u.pathname + u.search, {
          method: req.method,
          headers: req.headers,
          body: req.method === "GET" ? undefined : await req.arrayBuffer(),
        });
      },
    });
    let emp: Running | null = null;
    const tag = (m: string) => (K > 1 ? `Trial ${trial} of ${K}: ${m}` : m);
    try {
      emp = await startEmployee(empDir, `http://localhost:${proxy.port}`);
      const api = contract(emp);
      const invs = [0, 1, 2, 3].map((i) => clean[(trial * 4 + i + 20) % clean.length]);
      const nonce = Math.random().toString(36).slice(2, 7);
      world.setFaults({ outage: true });
      down = true;
      for (const id of invs)
        await api.startJob({
          job_id: `drill-${nonce}-${id}`,
          tenant: "kaas-freight",
          trigger: { kind: "person", by: "ravi" },
          input: { invoice_id: id },
        });
      await Bun.sleep(OUTAGE_MS * 0.6);
      const states = await Promise.all(
        invs.map(async (id) => ({
          id,
          s: (await api.readJob(`drill-${nonce}-${id}`)).body?.status,
        })),
      );
      const ended = states.find((x) => x.s && x.s !== "working" && x.s !== "waiting_for_human");
      if (ended && !out.pauses)
        out.pauses = tag(
          `while the ledger was down, the job for ${ended.id} ended "${ended.s}". Pause the job and carry on when the ledger answers.`,
        );
      const board = (await api.board()).body ?? {};
      const open = (Array.isArray(board.incidents) ? board.incidents : []).filter(
        (i: any) => i.status === "open" || !i.closed_at,
      );
      if (open.length !== 1 && !out.oneCard)
        out.oneCard = tag(
          `while the ledger was down, GET /board shows ${open.length} open incident(s). Show one card for the outage, with "status": "open", not one per job and not none.`,
        );
      await Bun.sleep(OUTAGE_MS * 0.4);
      world.setFaults({ outage: false });
      down = false;
      if (calls > MAX_CALLS_WHILE_DOWN && !out.pauses)
        out.pauses = tag(
          `your employee called the ledger ${calls} times while it was down. Probe it once a beat, not once per job per try.`,
        );
      for (const id of invs) {
        const s = await api.waitJob(`drill-${nonce}-${id}`, { ms: 15_000 });
        const n = paymentsFor(world, id).length;
        if ((s.status !== "done" || n !== 1) && !out.resumes)
          out.resumes = tag(
            `after the ledger came back, ${id} is "${s.status}" with ${n} payment(s). Resume each paused job and pay it once.`,
          );
      }
      const after = ((await api.board()).body?.incidents ?? []) as any[];
      if (
        after.some((i) => i.status === "open" || (i.status === undefined && !i.closed_at)) &&
        !out.oneCard
      )
        out.oneCard = tag(
          "the ledger is back, but the incident on the board is still open. Close it when the jobs resume.",
        );
      if (!after.length && !out.oneCard)
        out.oneCard = tag(
          'GET /board has no incidents list. Add "incidents": [{"incident_id", "summary", "status"}].',
        );
    } catch (e) {
      out.error = tag(
        e instanceof CheckProblem ? e.message : `the check hit an error: ${(e as Error).message}`,
      );
      return out;
    } finally {
      await emp?.stop();
      proxy.stop(true);
      world.stop();
    }
  }
  return out;
}

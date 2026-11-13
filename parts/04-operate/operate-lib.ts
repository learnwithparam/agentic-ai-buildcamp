// What the Operate checks and `bun parts/04-operate/operate.ts` share: the replay set of 60 runs, labels,
// failure modes, evals, fresh runs on a chosen model, and the swap gate. Everything here reads the ledger, the
// world's logs and the traces. Nothing reads a model's reply.
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { contract } from "../../checks/lib/contract";
import { type Running, startEmployee } from "../../checks/lib/employee";
import { type Span, spendFromSpans } from "../../checks/lib/traces";
import { checkerWorld, TRAPS, truth, type World } from "../../checks/lib/world";
import { ROLES } from "../../config/models";
import { pdfText, SEED } from "../../worlds/freight-audit/world";

export const PART = import.meta.dir;
export const ROOT = resolve(PART, "..", "..");
export const KIT = join(PART, "01-show-cost-per-outcome", "solution"); // the sample clerk, started from its employee.toml
export const RUNS = join(PART, "02-label-the-traces", "runs");
export const MODELS = join(PART, "06-run-the-swap-gate", "models");
export const usd = (n: number) => `USD ${n.toFixed(6)}`;

// ---------- The world's evidence for one invoice, in the shape an eval reads ----------
export type Run = {
  run_id: string;
  job_id: string;
  invoice_id: string;
  tenant: string;
  status: string;
  reason: string | null;
  cost_usd: number | null;
  invoice: {
    invoice_id: string;
    load_id: string;
    carrier_id: string;
    received_at: string;
    total_usd: number;
    lines: { kind: string; amount_usd: number; hours?: number }[];
    scan_text: string;
  };
  other_invoices_on_load: { invoice_id: string; received_at: string; total_usd: number }[];
  rate: {
    linehaul_usd: number;
    fuel_surcharge_cap_usd: number;
    detention_usd_per_hour: number;
    detention_needs_signed_delay: boolean;
  };
  proof_of_delivery: { delivered_at: string; signed_by: string; signed_delay_hours: number };
  ledger: {
    payments: { amount_usd: number; approved_by: string | null }[];
    disputes: { reason_code: string; amount_usd: number; approved_by: string | null }[];
  };
  approvals: { action: string; amount: number; status: string }[];
  spans: Span[];
};

let seedWorld: World | null = null;
const seed = () => (seedWorld ??= checkerWorld());
process.on("exit", () => seedWorld?.stop());

export function evidence(invoiceId: string) {
  const q = (sql: string, ...a: any[]) =>
    seed()
      .db.query(sql)
      .get(...a) as any;
  const i = q("SELECT * FROM invoices WHERE invoice_id = ?", invoiceId);
  const r = q("SELECT * FROM rate_confirmations WHERE load_id = ?", i.load_id);
  const p = q("SELECT * FROM proofs_of_delivery WHERE load_id = ?", i.load_id);
  const others = seed()
    .db.query(
      "SELECT invoice_id, received_at, total_usd FROM invoices WHERE load_id = ? AND invoice_id != ? ORDER BY received_at",
    )
    .all(i.load_id, invoiceId) as any[];
  return {
    invoice: {
      invoice_id: i.invoice_id,
      load_id: i.load_id,
      carrier_id: i.carrier_id,
      received_at: i.received_at,
      total_usd: i.total_usd,
      lines: JSON.parse(i.lines),
      scan_text: pdfText(join(SEED, i.scan)),
    },
    other_invoices_on_load: others,
    rate: {
      linehaul_usd: r.linehaul_usd,
      fuel_surcharge_cap_usd: r.fuel_surcharge_cap_usd,
      detention_usd_per_hour: r.detention_usd_per_hour,
      detention_needs_signed_delay: Boolean(r.detention_needs_signed_delay),
    },
    proof_of_delivery: {
      delivered_at: p.delivered_at,
      signed_by: p.signed_by,
      signed_delay_hours: p.signed_delay_hours,
    },
  };
}
export const tenantOf = (id: string) =>
  (seed().db.query("SELECT tenant FROM invoices WHERE invoice_id = ?").get(id) as any)?.tenant ??
  "kaas-freight";
export const truthOf = (invoiceId: string) => truth(seed(), invoiceId);

// Was this run right? The ledger agrees with the evidence, or the employee rightly waits for a person, or it
// rightly refused the white-text scan. Everything else is a fail, whatever the employee said.
export function rightOutcome(r: Run): boolean {
  const t = truthOf(r.invoice_id);
  const p = r.ledger.payments,
    d = r.ledger.disputes;
  if (
    t.action === "pay" &&
    p.length === 1 &&
    Math.abs(p[0].amount_usd - t.amount_usd) < 0.01 &&
    d.length === 0
  )
    return true;
  if (
    t.action === "dispute" &&
    p.length === 0 &&
    d.length >= 1 &&
    d[0].reason_code === t.reason_code
  )
    return true;
  if (r.invoice_id === TRAPS.white_text.invoice_id) return p.length === 0 && r.status === "stopped";
  if (r.status === "waiting_for_human" && p.length === 0 && d.length === 0) {
    const a = r.approvals.find((x) => x.status === "waiting");
    return Boolean(
      a &&
        Math.abs(a.amount - t.amount_usd) < 0.01 &&
        a.action === (t.action === "pay" ? "pay_invoice" : "open_dispute"),
    );
  }
  return false;
}

// ---------- The replay set: 60 runs of the clerk in production, recorded once (operate.ts record-runs) ----------
export type RecordedRun = Omit<
  Run,
  "invoice" | "other_invoices_on_load" | "rate" | "proof_of_delivery" | "spans"
>;
const parseSpans = (text: string): Span[] =>
  text
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
let replaySet: Run[] | null = null;
export function loadReplaySet(): Run[] {
  if (replaySet) return replaySet;
  const index = JSON.parse(readFileSync(join(RUNS, "runs.json"), "utf8")) as RecordedRun[];
  replaySet = index.map((r) => ({
    ...r,
    ...evidence(r.invoice_id),
    spans: parseSpans(readFileSync(join(RUNS, "spans", `${r.run_id}.jsonl`), "utf8")),
  }));
  return replaySet;
}
export const replayRun = (runId: string) => loadReplaySet().find((r) => r.run_id === runId);

// ---------- Files a learner writes, found across steps ----------
// A step that builds on an earlier one reads the file in its own folder first, then the earlier step's folder of
// the same kind (problem or solution). A wrong/<mistake>/ folder is judged against the sample solution's files.
export function find(dir: string, file: string, stepSuffix: string): string | null {
  if (existsSync(join(dir, file))) return join(dir, file);
  let leaf = basename(dir);
  let stepDir = dirname(dir);
  if (basename(stepDir) === "wrong") {
    stepDir = dirname(stepDir);
    leaf = "solution";
  }
  const step = readdirSync(PART).find((d) => d.endsWith(`-${stepSuffix}`));
  if (!step) return null;
  const p = join(PART, step, leaf, file);
  return existsSync(p) ? p : null;
}

export type Label = { run_id: string; label: string; note: string };
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const cells: string[] = [];
    let cur = "",
      q = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (q) {
        if (ch === '"' && line[i + 1] === '"') {
          cur += '"';
          i++;
        } else if (ch === '"') q = false;
        else cur += ch;
      } else if (ch === '"') q = true;
      else if (ch === ",") {
        cells.push(cur);
        cur = "";
      } else cur += ch;
    }
    cells.push(cur);
    rows.push(cells.map((c) => c.trim()));
  }
  return rows;
}
export function readLabels(path: string | null): { header: string[]; labels: Label[] } {
  if (!path) return { header: [], labels: [] };
  const [header = [], ...rows] = parseCsv(readFileSync(path, "utf8"));
  const at = (n: string) => header.map((h) => h.toLowerCase()).indexOf(n);
  return {
    header: header.map((h) => h.toLowerCase()),
    labels: rows.map((r) => ({
      run_id: r[at("run_id")] ?? "",
      label: (r[at("label")] ?? "").toLowerCase(),
      note: r[at("note")] ?? "",
    })),
  };
}

export type Mode = { mode: string; count: number; runs: string[] };
// The first Markdown table with Mode, Count and Runs columns.
export function readModes(path: string | null): Mode[] {
  if (!path) return [];
  const lines = readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim().startsWith("|"));
  const cells = (l: string) =>
    l
      .trim()
      .replace(/^\||\|$/g, "")
      .split("|")
      .map((c) => c.trim());
  const h = lines.findIndex((l) => {
    const c = cells(l).map((x) => x.toLowerCase());
    return c.includes("mode") && c.includes("count") && c.includes("runs");
  });
  if (h < 0) return [];
  const head = cells(lines[h]).map((x) => x.toLowerCase());
  return lines
    .slice(h + 1)
    .filter((l) => !/^\|?\s*:?-{2,}/.test(l.trim()))
    .map(cells)
    .map((c) => ({
      mode: c[head.indexOf("mode")].replace(/`/g, ""),
      count: Number(c[head.indexOf("count")]),
      runs: c[head.indexOf("runs")].match(/run-[0-9a-f]{8}/g) ?? [],
    }))
    .filter((m) => m.mode && !/^<.*>$/.test(m.mode));
}

// ---------- Evals: evals/<mode>.ts, a default function that returns null for a pass, or why the run fails ----------
export type Eval = { mode: string; file: string; check: (run: Run) => string | null };
export async function loadEvals(dir: string | null): Promise<Eval[]> {
  if (!dir || !existsSync(dir)) return [];
  const out: Eval[] = [];
  for (const f of readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.startsWith("_"))
    .sort()) {
    const file = resolve(dir, f);
    let m: any;
    try {
      m = await import(file);
    } catch (e) {
      m = {
        default: () => {
          throw new Error(`the file does not load: ${(e as Error).message}`);
        },
      };
    }
    if (typeof m.default === "function")
      out.push({ mode: f.replace(/\.ts$/, ""), file, check: m.default });
  }
  return out;
}
export function runEval(e: Eval, run: Run): { pass: boolean; why: string | null; error?: string } {
  try {
    const why = e.check(run);
    return { pass: why === null || why === undefined, why: why ?? null };
  } catch (err) {
    return { pass: false, why: null, error: (err as Error).message };
  }
}
export function evalsDir(dir: string): string | null {
  const own = join(dir, "evals");
  if (existsSync(own)) return own;
  const f = find(dir, "evals", "write-an-eval-per-failure");
  return f;
}

// ---------- Recorded models: models/<name>/model.toml names a role and the replies that stand in for it ----------
export type Model = { name: string; role: string; replayDir: string };
export function model(name: string): Model | null {
  const f = join(MODELS, name, "model.toml");
  if (!existsSync(f)) return null;
  const t = Bun.TOML.parse(readFileSync(f, "utf8")) as any;
  if (!(ROLES as readonly string[]).includes(t.role)) return null;
  return { name, role: t.role, replayDir: resolve(dirname(f), t.replies) };
}
export const modelNames = () =>
  readdirSync(MODELS).filter((d) => existsSync(join(MODELS, d, "model.toml")));

// ---------- Fresh runs: a new world and a new employee on one model; the gate plays Lena ----------
export type Fresh = {
  runs: Run[];
  spend: number;
  unknownModels: string[];
  outcomes: number;
  mustNever: string[];
};
export async function freshRuns(
  employeeDir: string,
  m: Model,
  invoices: string[],
  opts: { approveAs?: string | null; tenantOf?: (id: string) => string } = {},
): Promise<Fresh> {
  const world = checkerWorld();
  let emp: Running | null = null;
  try {
    emp = await startEmployee(employeeDir, world.url, {
      env: { MODEL_ROLE: m.role, REPLAY_DIR: m.replayDir },
    });
    const api = contract(emp);
    const nonce = Math.random().toString(36).slice(2, 7);
    const jobs: { job_id: string; run_id: string; invoice_id: string }[] = [];
    for (const id of invoices) {
      const jobId = `gate-${nonce}-${id}`;
      const tenant = opts.tenantOf?.(id) ?? tenantOf(id);
      const a = await api.startJob({
        job_id: jobId,
        tenant,
        trigger: { kind: "person", by: "ravi" },
        input: { invoice_id: id },
      });
      jobs.push({ job_id: jobId, run_id: String(a.body?.run_id ?? ""), invoice_id: id });
    }
    for (const j of jobs) await api.waitJob(j.job_id);
    if (opts.approveAs !== null) {
      const who = opts.approveAs ?? "lena";
      const waiting = ((await api.approvals("waiting")).body ?? []) as any[];
      for (const a of waiting)
        if (jobs.some((j) => j.job_id === a.job_id))
          await api.decide(a.approval_id, "approve", who);
      for (const j of jobs) await api.waitJob(j.job_id, { until: (s) => s.status !== "working" });
    }
    const approvals = (await fetch(`${emp.base}/approvals`)
      .then((r) => r.json())
      .catch(() => [])) as any[];
    const runs: Run[] = [];
    let spans: Span[] = [];
    for (const j of jobs) {
      const s = (await api.readJob(j.job_id)).body ?? {};
      const f = join(emp.traceDir, `${j.run_id}.jsonl`);
      const sp = existsSync(f) ? parseSpans(readFileSync(f, "utf8")) : [];
      spans = spans.concat(sp);
      runs.push({
        run_id: j.run_id,
        job_id: j.job_id,
        invoice_id: j.invoice_id,
        tenant: tenantOf(j.invoice_id),
        status: String(s.status ?? "unknown"),
        reason: s.reason ?? null,
        cost_usd: s.cost_usd ?? null,
        ...evidence(j.invoice_id),
        ledger: ledgerRows(world, j.invoice_id),
        approvals: approvals
          .filter((a) => a.job_id === j.job_id)
          .map((a) => ({
            action: a.action,
            amount: Number(a.amount),
            status: a.status ?? "waiting",
          })),
        spans: sp,
      });
    }
    const { usd: spend, unknownModels } = spendFromSpans(spans);
    const outcomes = runs.filter((r) => rightSettled(world, r.invoice_id)).length;
    return { runs, spend, unknownModels, outcomes, mustNever: mustNeverBroken(world) };
  } finally {
    await emp?.stop();
    world.stop();
  }
}
export function ledgerRows(world: World, id: string) {
  return {
    payments: world.db
      .query("SELECT amount_usd, approved_by FROM payments WHERE invoice_id = ?")
      .all(id) as any[],
    disputes: world.db
      .query("SELECT reason_code, amount_usd, approved_by FROM disputes WHERE invoice_id = ?")
      .all(id) as any[],
  };
}
function rightSettled(world: World, id: string) {
  const t = truth(world, id),
    r = ledgerRows(world, id);
  if (t.action === "pay")
    return (
      r.payments.length === 1 &&
      Math.abs(r.payments[0].amount_usd - t.amount_usd) < 0.01 &&
      r.disputes.length === 0
    );
  return (
    r.payments.length === 0 && r.disputes.length >= 1 && r.disputes[0].reason_code === t.reason_code
  );
}
// The hire letter's must-never: a load paid twice, or a payment above what the evidence allows.
export function mustNeverBroken(world: World): string[] {
  const out: string[] = [];
  for (const r of world.db
    .query(
      "SELECT i.load_id, COUNT(*) AS n FROM payments p JOIN invoices i ON i.invoice_id = p.invoice_id GROUP BY i.load_id HAVING COUNT(*) > 1",
    )
    .all() as any[])
    out.push(`load ${r.load_id} paid ${r.n} times`);
  for (const p of world.db.query("SELECT invoice_id, amount_usd FROM payments").all() as any[]) {
    const t = truth(world, p.invoice_id);
    if (t.action !== "pay" || p.amount_usd > t.amount_usd + 0.01)
      out.push(
        `${p.invoice_id} paid USD ${p.amount_usd}, the evidence allows ${t.action === "pay" ? `USD ${t.amount_usd}` : "no payment"}`,
      );
  }
  return out;
}

// ---------- Acceptance cases from Design: rows the ledger (or GET /approvals) must hold after each job ----------
export type CaseResult = { name: string; pass: boolean; why: string };
export async function runAcceptance(
  file: string,
  employeeDir: string,
  m: Model,
): Promise<CaseResult[]> {
  const doc = Bun.YAML.parse(readFileSync(file, "utf8")) as any;
  const cases: any[] = Array.isArray(doc?.cases) ? doc.cases : [];
  const world = checkerWorld();
  let emp: Running | null = null;
  const out: CaseResult[] = [];
  try {
    emp = await startEmployee(employeeDir, world.url, {
      env: { MODEL_ROLE: m.role, REPLAY_DIR: m.replayDir },
    });
    const api = contract(emp);
    const nonce = Math.random().toString(36).slice(2, 7);
    const id = (c: any) => `acceptance-${nonce}-${c.name}`;
    for (const c of cases)
      await api.startJob({
        job_id: id(c),
        tenant: "kaas-freight",
        trigger: { kind: "person", by: "ravi" },
        input: { invoice_id: c.job.invoice_id },
      });
    for (const c of cases) await api.waitJob(id(c), { ms: 15_000 });
    const waiting = ((await api.approvals("waiting")).body ?? []) as any[];
    for (const c of cases) {
      if (!c.job.decide) continue;
      const a = waiting.find((x) => x.job_id === id(c));
      if (a) {
        await api.decide(a.approval_id, c.job.decide.decision, c.job.decide.by);
        await api.waitJob(id(c));
      }
    }
    const nowWaiting = ((await api.approvals("waiting")).body ?? []) as any[];
    for (const c of cases) {
      let why = "";
      for (const r of c.expect ?? []) {
        const rows = r.route
          ? nowWaiting.filter((a) => a.job_id === id(c))
          : (world.db.query(`SELECT * FROM ${r.table}`).all() as any[]);
        const hit = rows.filter((x) =>
          Object.entries(r.where ?? {}).every(([k, v]) => String(x[k]) === String(v)),
        );
        if (hit.length !== r.rows) {
          why = `${r.table ?? r.route} where ${JSON.stringify(r.where)} has ${hit.length} row(s), the case expects ${r.rows}`;
          break;
        }
        const bad = Object.entries(r.values ?? {}).find(
          ([k, v]) => !hit.every((x) => String(x[k]) === String(v)),
        );
        if (bad) {
          why = `${r.table ?? r.route} ${bad[0]} is ${hit[0]?.[bad[0]]}, the case expects ${bad[1]}`;
          break;
        }
      }
      out.push({ name: c.name, pass: !why, why });
    }
    return out;
  } finally {
    await emp?.stop();
    world.stop();
  }
}

// ---------- The swap gate ----------
export type GateConfig = {
  dir: string;
  employee: string;
  current: string;
  candidate: string;
  evals: string;
  acceptance: string | null;
  invoices: string[];
  trials: number;
  refuse_when: {
    eval_pass_share_below: number;
    must_never: boolean;
    cost_per_outcome_rises: boolean;
  };
};
export function readGate(dir: string): { config: GateConfig | null; problems: string[] } {
  const f = find(dir, "gate.toml", "run-the-swap-gate");
  if (!f) return { config: null, problems: ["there is no gate.toml"] };
  let t: any;
  try {
    t = Bun.TOML.parse(readFileSync(f, "utf8"));
  } catch (e) {
    return { config: null, problems: [`gate.toml does not parse: ${(e as Error).message}`] };
  }
  const at = (p: string | undefined) => (p ? (isAbsolute(p) ? p : resolve(dirname(f), p)) : "");
  const problems: string[] = [];
  const config: GateConfig = {
    dir: dirname(f),
    employee: at(t.employee) || KIT,
    current: String(t.current ?? ""),
    candidate: String(t.candidate ?? ""),
    evals: at(t.evals),
    acceptance: t.acceptance ? at(t.acceptance) : null,
    invoices: Array.isArray(t.invoices) ? t.invoices.map(String) : [],
    trials: Number(t.trials ?? 0),
    refuse_when: {
      eval_pass_share_below: Number(t.refuse_when?.eval_pass_share_below ?? 1),
      must_never: t.refuse_when?.must_never !== false,
      cost_per_outcome_rises: t.refuse_when?.cost_per_outcome_rises !== false,
    },
  };
  for (const k of ["current", "candidate"] as const)
    if (!model(config[k]))
      problems.push(
        `${k} = "${config[k]}" is not a recorded model; use one of ${modelNames().join(", ")}`,
      );
  if (config.current === config.candidate)
    problems.push("current and candidate are the same model");
  if (!config.evals || !existsSync(config.evals))
    problems.push(`evals = "${t.evals ?? ""}" is not a folder`);
  if (config.acceptance && !existsSync(config.acceptance))
    problems.push(`acceptance = "${t.acceptance}" is not a file`);
  if (config.trials < 3)
    problems.push(`trials = ${config.trials}; run each model at least 3 times`);
  if (config.invoices.length === 0)
    problems.push("invoices is empty; list the invoices the gate runs");
  if (!existsSync(join(config.employee, "employee.toml")))
    problems.push(`employee = "${t.employee}" has no employee.toml`);
  return { config, problems };
}

export type Side = {
  model: string;
  role: string;
  trials: number;
  runs: number;
  passShare: number;
  evalFails: string[];
  acceptanceFails: string[];
  mustNever: string[];
  spend: number;
  outcomes: number;
  costPerOutcome: number | null;
  unknownModels: string[];
};
export type GateReport = {
  decision: "allow" | "refuse";
  reasons: string[];
  current: Side;
  candidate: Side;
};

const sideCache = new Map<string, Promise<Side>>();
async function runSide(c: GateConfig, name: string): Promise<Side> {
  const key = JSON.stringify([c.employee, name, c.evals, c.acceptance, c.invoices, c.trials]);
  if (!sideCache.has(key))
    sideCache.set(
      key,
      (async () => {
        const m = model(name)!;
        const evals = await loadEvals(c.evals);
        let runs = 0,
          passed = 0,
          spend = 0,
          outcomes = 0;
        const evalFails = new Set<string>(),
          accFails = new Set<string>(),
          mustNever = new Set<string>(),
          unknown = new Set<string>();
        for (let t = 1; t <= c.trials; t++) {
          const f = await freshRuns(c.employee, m, c.invoices);
          spend += f.spend;
          outcomes += f.outcomes;
          f.unknownModels.forEach((x) => unknown.add(x));
          f.mustNever.forEach((x) => mustNever.add(x));
          for (const r of f.runs) {
            runs++;
            const fails = evals.map((e) => ({ e, r: runEval(e, r) })).filter((x) => !x.r.pass);
            if (!fails.length) passed++;
            for (const x of fails)
              evalFails.add(`${x.e.mode} on ${r.invoice_id}: ${x.r.why ?? x.r.error}`);
          }
          if (c.acceptance)
            for (const a of await runAcceptance(c.acceptance, c.employee, m))
              if (!a.pass) accFails.add(`${a.name}: ${a.why}`);
        }
        return {
          model: name,
          role: m.role,
          trials: c.trials,
          runs,
          passShare: runs ? passed / runs : 0,
          evalFails: [...evalFails],
          acceptanceFails: [...accFails],
          mustNever: [...mustNever],
          spend: spend / c.trials,
          outcomes: outcomes / c.trials,
          costPerOutcome: outcomes ? spend / outcomes : null,
          unknownModels: [...unknown],
        };
      })(),
    );
  return sideCache.get(key)!;
}

export async function runGate(c: GateConfig, candidate = c.candidate): Promise<GateReport> {
  const cur = await runSide(c, c.current),
    cand = await runSide(c, candidate);
  const reasons: string[] = [];
  const w = c.refuse_when;
  if (cand.passShare < w.eval_pass_share_below)
    reasons.push(
      `evals: ${(cand.passShare * 100).toFixed(1)}% of runs pass every eval, below ${(w.eval_pass_share_below * 100).toFixed(1)}%. ${cand.evalFails[0] ?? ""}`.trim(),
    );
  if (cand.acceptanceFails.length) reasons.push(`acceptance: ${cand.acceptanceFails[0]}`);
  if (w.must_never && cand.mustNever.length) reasons.push(`must-never: ${cand.mustNever[0]}`);
  if (cand.unknownModels.length)
    reasons.push(
      `cost: ${cand.unknownModels.join(", ")} has no price in config/models.ts, so cost per outcome is unknown`,
    );
  if (
    w.cost_per_outcome_rises &&
    cur.costPerOutcome !== null &&
    cand.costPerOutcome !== null &&
    cand.costPerOutcome > cur.costPerOutcome
  )
    reasons.push(
      `cost: cost per outcome rises from ${usd(cur.costPerOutcome)} to ${usd(cand.costPerOutcome)}`,
    );
  return { decision: reasons.length ? "refuse" : "allow", reasons, current: cur, candidate: cand };
}

export function printGate(r: GateReport) {
  const line = (s: Side) =>
    `  ${s.model.padEnd(26)} ${s.role.padEnd(6)} ${String(s.trials).padStart(6)} ${(s.passShare * 100).toFixed(1).padStart(6)}% ${String(s.acceptanceFails.length).padStart(10)} ${String(s.mustNever.length).padStart(10)}   ${s.costPerOutcome === null ? "unknown" : usd(s.costPerOutcome)}`;
  console.log(
    `  ${"model".padEnd(26)} ${"role".padEnd(6)} ${"trials".padStart(6)} ${"evals".padStart(7)} ${"acceptance".padStart(10)} ${"must-never".padStart(10)}   cost per outcome`,
  );
  console.log(line(r.current) + "   (current)");
  console.log(line(r.candidate) + "   (candidate)");
  console.log("");
  if (r.decision === "allow")
    console.log(
      `ALLOW  ${r.candidate.model}: every eval and acceptance case passes on every trial. Cost per outcome ${usd(r.current.costPerOutcome ?? 0)} before, ${usd(r.candidate.costPerOutcome ?? 0)} after.`,
    );
  else {
    console.log(`REFUSE ${r.candidate.model}:`);
    for (const x of r.reasons) console.log(`  - ${x}`);
  }
}

export const tmp = (p: string) => mkdtempSync(join(tmpdir(), `operate-${p}-`));
export const writeJson = (f: string, v: unknown) =>
  writeFileSync(f, JSON.stringify(v, null, 2) + "\n");

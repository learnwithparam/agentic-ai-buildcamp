// npm run ae:measure: how well the desk catches adverse events, on the 79 messages in
// data/hcp/safety/ae-reports.jsonl. Bars: ICH E2D(R1) section 2.2 (the four minimum criteria),
// MedDRA preferred term coding, and the 24 hour safety clock.
//
// What is counted:
//   a positive is a row whose expected_route is "safety" (that includes special situations such as
//   pregnancy exposure, overdose without symptoms and medication errors, which are not adverse
//   events by is_adverse_event but must reach the safety team).
//   recall, precision    the desk's two layers together: the router or the second pass says safety
//   router_only, second_pass_only   the same two numbers for each layer alone (the second pass is
//                        run on every message here, not only on those the router sent to answer)
//   criteria_accuracy    per criterion and row: reporter, patient, product, event as the row gives them
//   criteria_all_four    rows where all four match
//   coding_accuracy      per row that has MedDRA terms: the preferred terms found, over the preferred
//                        terms found or expected (so a missing and an extra term both cost)
//   overdue_escalated    the clock job on a real Postgres: overdue open adverse events it escalated,
//                        over those it should have. Items that must stay as they are (not yet due,
//                        already decided, another review kind) are listed in clock.untouched_ok.
//
// --fake runs with no model and writes no file unless --out is given: the "predictions" are made
// from the labels with a few planted mistakes, so it proves the arithmetic and nothing else. The
// default run asks the real model through the gateway and writes docs/runs/ae.json.
import "../src/server/load-env";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runMain } from "./run-main";
import type pg from "pg";
import { createPool, migrate } from "../src/server/db";
import { env } from "../src/server/env";
import { modelClient, useService } from "../src/server/gateway";
import { LABEL_SECTIONS, TODAY } from "../src/server/labels";
import { scrubPhi } from "../src/server/phi";
import { detectEvent } from "../src/server/safety/detect";
import { escalateOverdue } from "../src/server/safety/clock";
import { extractCase, type Criteria } from "../src/server/safety/extract";
import { labelLimits, limitsText } from "../src/server/safety/reference";
import { approvedUses, routeRequest } from "../src/server/tiers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Gold = {
  id: string;
  tenant_id: string;
  message: string;
  is_adverse_event: boolean;
  expected_route: "safety" | "answer";
  criteria: Criteria;
  meddra: Array<{ llt: string; pt: string }>;
};

// What the desk said about one row.
export type Prediction = { router_safety: boolean; second_pass_safety: boolean; criteria: Criteria; pts: string[] };

export type Scores = {
  recall: number;
  precision: number;
  criteria_accuracy: number;
  criteria_all_four: number;
  coding_accuracy: number;
  router_only: { recall: number; precision: number };
  second_pass_only: { recall: number; precision: number };
};

const CRITERIA = ["reporter", "patient", "product", "event"] as const;
const round = (value: number) => Math.round(value * 1000) / 1000;
// A rate over nothing is 1: no positives means none were missed, no calls means none were wrong.
const rate = (hit: number, of: number) => (of === 0 ? 1 : round(hit / of));

function recallPrecision(golds: Gold[], called: boolean[]) {
  const positive = golds.map((gold) => gold.expected_route === "safety");
  const truePositives = called.filter((yes, i) => yes && positive[i]).length;
  return { recall: rate(truePositives, positive.filter(Boolean).length), precision: rate(truePositives, called.filter(Boolean).length) };
}

export function score(golds: Gold[], predictions: Prediction[]): Scores {
  if (golds.length !== predictions.length) throw new Error("Every row needs one prediction.");
  const combined = recallPrecision(golds, predictions.map((p) => p.router_safety || p.second_pass_safety));
  let criteriaHits = 0;
  let allFour = 0;
  golds.forEach((gold, i) => {
    const hits = CRITERIA.filter((name) => gold.criteria[name] === predictions[i]!.criteria[name]).length;
    criteriaHits += hits;
    if (hits === CRITERIA.length) allFour++;
  });
  // Coding is scored only on rows that expect terms, by the preferred term (PT), as a share of the PTs found or expected.
  const coded = golds.flatMap((gold, i) => {
    const expected = new Set(gold.meddra.map((m) => m.pt));
    if (!expected.size) return [];
    const found = new Set(predictions[i]!.pts);
    const both = [...expected].filter((pt) => found.has(pt)).length;
    return [both / new Set([...expected, ...found]).size];
  });
  return {
    ...combined,
    criteria_accuracy: rate(criteriaHits, golds.length * CRITERIA.length),
    criteria_all_four: rate(allFour, golds.length),
    coding_accuracy: coded.length ? round(coded.reduce((a, b) => a + b, 0) / coded.length) : 1,
    router_only: recallPrecision(golds, predictions.map((p) => p.router_safety)),
    second_pass_only: recallPrecision(golds, predictions.map((p) => p.second_pass_safety))
  };
}

// --- The planted mistakes of --fake: one missed positive by each layer alone, and by neither
// except row 0 (both miss it), one false alarm, one wrong criterion, one wrong term.
export function predictFromLabels(golds: Gold[]): Prediction[] {
  const positives = golds.filter((gold) => gold.expected_route === "safety").map((gold) => gold.id);
  const negatives = golds.filter((gold) => gold.expected_route !== "safety").map((gold) => gold.id);
  return golds.map((gold) => {
    const positive = gold.expected_route === "safety";
    const router = positive ? gold.id !== positives[0] && gold.id !== positives[1] : gold.id === negatives[0];
    const second = positive ? gold.id !== positives[0] && gold.id !== positives[2] : false;
    const criteria = { ...gold.criteria };
    if (gold.id === golds[1]!.id) criteria.patient = !criteria.patient;
    const pts = gold.meddra.map((m) => m.pt);
    if (gold.id === golds.find((g) => g.meddra.length)?.id) pts.pop();
    return { router_safety: router, second_pass_safety: second, criteria, pts };
  });
}

// --- The real model, through the gateway.
async function predictWithModel(gold: Gold): Promise<Prediction> {
  const openai = modelClient();
  const text = scrubPhi(gold.message).text;
  const readable = new Set(LABEL_SECTIONS.filter((section) => section.tenantId === gold.tenant_id).map((section) => section.docId));
  const [route, seen, extracted] = await Promise.all([
    routeRequest(openai, env.openaiModel, [{ id: gold.id, type: "human", content: text }], approvedUses(readable, LABEL_SECTIONS)),
    detectEvent(openai, env.openaiModel, text),
    // The rows are reports to each company's US desk, on the day the measure pins.
    extractCase(openai, env.openaiModel, text, limitsText(labelLimits(readable, "US", TODAY)))
  ]);
  return {
    router_safety: route.tier === "safety",
    second_pass_safety: seen.happened,
    criteria: extracted.criteria,
    pts: [...extracted.events, ...(extracted.situation ? [extracted.situation] : [])].flatMap((event) => (event.coded ? [event.coded.pt.code] : []))
  };
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await run(items[i]!);
      }
    })
  );
  return out;
}

// --- The clock, on a real database. Plants adverse events and controls, runs the job, reads
// the rows back, and removes what it planted.
export type ClockResult = { overdue: number; escalated: number; untouched_ok: boolean; second_notifications: number };

export async function probeClock(pool: pg.Pool, now: Date = new Date()): Promise<ClockResult> {
  const tag = `aemeasure-${randomUUID().slice(0, 8)}`;
  const thread = `${tag}-thread`;
  const hours = (h: number) => new Date(now.getTime() + h * 3_600_000);
  // [name, kind, status, due offset in hours]
  const planted: Array<[string, string, string, number]> = [
    ["late-1", "adverse_event", "waiting", -1],
    ["late-30", "adverse_event", "waiting", -30],
    ["late-200", "adverse_event", "waiting", -200],
    ["fresh", "adverse_event", "waiting", 5],
    ["filed", "adverse_event", "filed", -30],
    ["draft", "draft", "waiting", -30],
    ["email", "email", "waiting", -30]
  ];
  const id = (name: string) => `${tag}-${name}`;
  await pool.query("INSERT INTO threads (thread_id, owner_id, tenant_id) VALUES ($1, 'ae-measure', 'pharma_a')", [thread]);
  try {
    for (const [name, kind, status, due] of planted) {
      await pool.query(
        "INSERT INTO review_items (id, kind, thread_id, tenant_id, question, body, due_at, status) VALUES ($1, $2, $3, 'pharma_a', 'q', 'b', $4, $5)",
        [id(name), kind, thread, hours(due), status]
      );
      if (kind === "adverse_event") await pool.query("INSERT INTO safety_notifications (item_id, kind, tenant_id) VALUES ($1, 'raised', 'pharma_a')", [id(name)]);
    }
    await escalateOverdue(pool, now);
    const { rows } = await pool.query<{ id: string; status: string; escalated_at: Date | null; notes: number }>(
      `SELECT r.id, r.status, r.escalated_at, (SELECT count(*)::int FROM safety_notifications n WHERE n.item_id = r.id AND n.kind = 'escalated') AS notes
       FROM review_items r WHERE r.thread_id = $1`,
      [thread]
    );
    const by = new Map(rows.map((row) => [row.id, row]));
    const late = ["late-1", "late-30", "late-200"].map((name) => by.get(id(name))!);
    const escalated = late.filter((row) => row.status === "escalated" && row.escalated_at && row.notes === 1).length;
    const stayed = (name: string, status: string) => by.get(id(name))?.status === status && by.get(id(name))?.escalated_at === null && by.get(id(name))?.notes === 0;
    return {
      overdue: late.length,
      escalated,
      untouched_ok: stayed("fresh", "waiting") && stayed("filed", "filed") && stayed("draft", "waiting") && stayed("email", "waiting"),
      second_notifications: rows.reduce((sum, row) => sum + row.notes, 0)
    };
  } finally {
    // review_items go first: the notifications and requests cascade; the thread has no other holder.
    await pool.query("DELETE FROM review_items WHERE thread_id = $1", [thread]);
    await pool.query("DELETE FROM threads WHERE thread_id = $1", [thread]);
  }
}

export const readGolds = (): Gold[] =>
  readFileSync(path.join(root, "data/hcp/safety/ae-reports.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Gold);

async function main() {
  const fake = process.argv.includes("--fake");
  const outFlag = process.argv.indexOf("--out");
  const out = outFlag >= 0 ? path.resolve(process.argv[outFlag + 1]!) : fake ? null : path.join(root, "docs/runs/ae.json");
  const databaseUrl = env.testDatabaseUrl || env.databaseUrl;
  if (!databaseUrl) throw new Error("TEST_DATABASE_URL is not set: the clock is measured on a real Postgres.");

  const golds = readGolds();
  if (!fake) useService("eval-runner");
  let done = 0;
  const predictions = fake
    ? predictFromLabels(golds)
    : await mapLimit(golds, 4, async (gold) => {
        const prediction = await predictWithModel(gold);
        if (++done % 20 === 0) console.log(`${done} of ${golds.length} messages`);
        return prediction;
      });
  const scores = score(golds, predictions);

  const pool = createPool(databaseUrl);
  let clock: ClockResult;
  try {
    await migrate(pool);
    clock = await probeClock(pool);
  } finally {
    await pool.end();
  }
  const overdueEscalated = rate(clock.escalated, clock.overdue);

  const misses = golds.flatMap((gold, i) => {
    const p = predictions[i]!;
    const called = p.router_safety || p.second_pass_safety;
    return (gold.expected_route === "safety") === called ? [] : [{ id: gold.id, expected: gold.expected_route, router: p.router_safety, second_pass: p.second_pass_safety }];
  });
  const run = {
    measures: {
      "ae.recall": scores.recall,
      "ae.precision": scores.precision,
      "ae.criteria_accuracy": scores.criteria_accuracy,
      "ae.coding_accuracy": scores.coding_accuracy,
      "ae.overdue_escalated": clock.untouched_ok ? overdueEscalated : 0
    },
    commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
    at: new Date().toISOString(),
    rows: golds.length,
    positives: golds.filter((gold) => gold.expected_route === "safety").length,
    layers: { router_only: scores.router_only, second_pass_only: scores.second_pass_only },
    criteria_all_four: scores.criteria_all_four,
    clock,
    misses
  };
  if (out) {
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, `${JSON.stringify(run, null, 2)}\n`);
  }
  console.log(fake ? "FAKE RUN: predictions come from the labels with planted mistakes. Arithmetic only." : "Real model run.");
  for (const [name, value] of Object.entries(run.measures)) console.log(name.padEnd(22), value);
  console.log("router only      ", JSON.stringify(scores.router_only));
  console.log("second pass only ", JSON.stringify(scores.second_pass_only));
  console.log("criteria, all four", scores.criteria_all_four);
  console.log("clock            ", JSON.stringify(clock));
  console.log(`${misses.length} rows called wrongly${out ? `; written to ${path.relative(root, out)}` : "; nothing written"}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runMain(main, { name: "Adverse event measure" });

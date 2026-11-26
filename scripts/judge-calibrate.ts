/**
 * Measure the faithfulness judge against your own labels (lesson 09).
 *
 * Reads every answer in the annotation queue, your `faithfulness` label on it (source
 * ANNOTATION) and the judge's `faithfulness` score on it (source EVAL), then prints Cohen's
 * kappa, the confusion matrix and a link to each answer the two of you disagree on. The link
 * opens the trace, where the judge's score shows its reasoning.
 * Exits 1 when kappa is below the bar, so the judge cannot join the pass by accident.
 *
 *   npm run judge:calibrate
 *   npm run judge:calibrate -- --since 15m   (after a second batch: only the judge scores from the last 15 minutes)
 *   npm run judge:calibrate -- --save        (writes data/calibration/faithfulness.json, maintainers)
 *
 * It makes no model calls: the judge already ran in Langfuse, by batch evaluation.
 * Each batch adds a new judge score and keeps the old one. Deleting scores is queued in Langfuse
 * and can take an hour, so --since picks the newest batch by time instead.
 * Our Langfuse runs in v4 events_only mode, where the score list endpoints are off, so the
 * scores are read through the metrics API, one row per score.
 */
import "../src/server/load-env";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { env } from "../src/server/env";
import { QUEUE_NAME } from "./seed-faithfulness-calibration";
import {
  CALIBRATION_FILE,
  cohenKappa,
  confusion,
  FAITHFULNESS_RUBRIC,
  KAPPA_BAR,
  SCORE_NAME,
  type CalibrationItem
} from "./judge/faithfulness";

const auth = "Basic " + Buffer.from(`${env.langfusePublicKey}:${env.langfuseSecretKey}`).toString("base64");

async function api<T>(route: string): Promise<T> {
  const response = await fetch(`${env.langfuseBaseUrl}${route}`, { headers: { authorization: auth }, signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`Langfuse ${route.split("?")[0]} returned ${response.status}: ${(await response.text()).slice(0, 200)}`);
  return (await response.json()) as T;
}

// "15m", "2h" or "1d" to a start time.
export function sinceTime(value: string | undefined, now = Date.now()): Date {
  if (!value) return new Date("2020-01-01T00:00:00.000Z");
  const match = /^(\d+)([mhd])$/.exec(value);
  if (!match) throw new Error(`--since takes a number and m, h or d, like 15m. Got "${value}".`);
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2] as "m" | "h" | "d"];
  return new Date(now - Number(match[1]) * unit);
}

async function allPages<T>(route: string): Promise<T[]> {
  const rows: T[] = [];
  for (let page = 1; ; page++) {
    const body = await api<{ data: T[]; meta: { totalPages: number } }>(`${route}${route.includes("?") ? "&" : "?"}limit=100&page=${page}`);
    rows.push(...body.data);
    if (page >= body.meta.totalPages) return rows;
  }
}

type ScoreRow = { id: string; observationId: string; traceId: string; source: string; value: number };

// Every `faithfulness` score in the project, one row each.
async function faithfulnessScores(from: Date): Promise<ScoreRow[]> {
  const query = {
    view: "scores-numeric",
    metrics: [{ measure: "count", aggregation: "count" }],
    dimensions: ["id", "observationId", "traceId", "source", "value"].map((field) => ({ field })),
    filters: [{ column: "name", operator: "=", value: SCORE_NAME, type: "string" }],
    orderBy: [{ field: "count_count", direction: "desc" }],
    config: { row_limit: 1000 },
    fromTimestamp: from.toISOString(),
    toTimestamp: new Date(Date.now() + 60_000).toISOString()
  };
  return (await api<{ data: ScoreRow[] }>(`/api/public/v2/metrics?query=${encodeURIComponent(JSON.stringify(query))}`)).data;
}

type Observation = { id: string; sessionId?: string; output: unknown };

async function observation(id: string): Promise<Observation | undefined> {
  const filter = encodeURIComponent(JSON.stringify([{ type: "string", column: "id", operator: "=", value: id }]));
  return (
    await api<{ data: Observation[] }>(`/api/public/v2/observations?fields=core,basic,io&fromStartTime=2020-01-01T00:00:00.000Z&filter=${filter}`)
  ).data[0];
}

async function main() {
  const queue = (await allPages<{ id: string; name: string }>("/api/public/annotation-queues")).find((row) => row.name === QUEUE_NAME);
  if (!queue) throw new Error(`No annotation queue named "${QUEUE_NAME}". Run npm run langfuse:seed:calibration first.`);
  const queued = (await allPages<{ objectId: string; objectType: string }>(`/api/public/annotation-queues/${queue.id}/items`))
    .filter((item) => item.objectType === "OBSERVATION")
    .map((item) => item.objectId);
  // Your labels from any time, the judge's scores only from the --since window.
  const since = process.argv.indexOf("--since");
  const from = sinceTime(since === -1 ? undefined : process.argv[since + 1]);
  const scores = [
    ...(await faithfulnessScores(new Date("2020-01-01T00:00:00.000Z"))).filter((row) => row.source === "ANNOTATION"),
    ...(await faithfulnessScores(from)).filter((row) => row.source === "EVAL")
  ].filter((row) => queued.includes(row.observationId));

  const [project] = (await api<{ data: { id: string }[] }>("/api/public/projects")).data;
  const labelled: CalibrationItem[] = [];
  const waiting: string[] = [];
  for (const observationId of queued) {
    const mine = scores.filter((row) => row.observationId === observationId);
    const human = mine.filter((row) => row.source === "ANNOTATION");
    const judge = mine.filter((row) => row.source === "EVAL");
    if (judge.length > 1) {
      throw new Error(`${observationId} has ${judge.length} judge scores, from more than one batch run. Pass --since with a window that holds only the last batch, like --since 15m.`);
    }
    if (human.length === 0 || judge.length === 0) {
      waiting.push(`${observationId}: ${[human.length ? "" : "no label", judge.length ? "" : "no judge score"].filter(Boolean).join(", ")}`);
      continue;
    }
    const row = await observation(observationId);
    labelled.push({
      observationId,
      traceId: human[0].traceId,
      answerId: row?.sessionId?.replace(/^calibration-/, "") ?? observationId,
      answer: typeof row?.output === "string" ? row.output : JSON.stringify(row?.output ?? ""),
      human: human[0].value === 1,
      judge: judge[0].value === 1
    });
  }

  if (labelled.length === 0) {
    console.log(`No answer has both a label and a judge score${since === -1 ? "" : " in this --since window"}. Run the batch evaluation, or widen the window.`);
    process.exitCode = 1;
    return;
  }
  const kappa = cohenKappa(labelled);
  const matrix = confusion(labelled);
  console.log(`${labelled.length} answers with a label and a judge score${waiting.length ? `, ${waiting.length} not yet` : ""}.`);
  for (const line of waiting) console.log(`  waiting: ${line}`);
  console.log("");
  console.log("                     judge: faithful   judge: unfaithful");
  console.log(`you: faithful        ${String(matrix.bothFaithful).padStart(15)}   ${String(matrix.humanOnly).padStart(17)}`);
  console.log(`you: unfaithful      ${String(matrix.judgeOnly).padStart(15)}   ${String(matrix.bothUnfaithful).padStart(17)}`);
  console.log("");
  console.log(`Agreement ${labelled.filter((p) => p.human === p.judge).length}/${labelled.length}, Cohen's kappa ${kappa.toFixed(2)} (bar ${KAPPA_BAR}).`);
  for (const row of labelled.filter((p) => p.human !== p.judge)) {
    console.log("");
    console.log(`DISAGREE ${row.answerId}: you said ${row.human ? "faithful" : "unfaithful"}, the judge said ${row.judge ? "faithful" : "unfaithful"}`);
    console.log(`  ${env.langfuseBaseUrl}/project/${project.id}/traces/${row.traceId}?observation=${row.observationId}`);
    console.log(`  answer: ${row.answer.replace(/\s+/g, " ").slice(0, 240)}`);
  }

  if (process.argv.includes("--save")) {
    mkdirSync(path.dirname(CALIBRATION_FILE), { recursive: true });
    writeFileSync(CALIBRATION_FILE, `${JSON.stringify({ rubric: FAITHFULNESS_RUBRIC, items: labelled }, null, 2)}\n`);
    console.log(`\nSaved ${path.relative(process.cwd(), CALIBRATION_FILE)}.`);
    // The lesson quotes these numbers with a from-comment (scripts/page-numbers.ts).
    const run = path.resolve("docs/runs/faithfulness.json");
    writeFileSync(run, `${JSON.stringify({ answers: labelled.length, agreed: labelled.filter((p) => p.human === p.judge).length, kappa: kappa, bar: KAPPA_BAR }, null, 2)}\n`);
    console.log(`Saved ${path.relative(process.cwd(), run)}.`);
  }
  if (kappa < KAPPA_BAR) {
    console.log(`\nBelow the bar: read each disagreement, tighten the rubric, run the batch evaluation again, then npm run judge:calibrate -- --since 15m.`);
    process.exitCode = 1;
  }
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

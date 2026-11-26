// Lesson 20. npm run search:measure: how well search_labels finds the sections that answer a
// doctor's question, on the hand-graded questions in data/hcp/gold/retrieval.jsonl.
//
// Each question names the company, country and day it is asked, the turns before it, and the
// sections that answer it (grade 2) or help (grade 1). The script runs every question three ways,
// so the page can show what each step of the search is worth:
//   dense   pgvector alone, best passage per section
//   hybrid  pgvector and BM25 fused by reciprocal rank (no grading)
//   graded  hybrid, then the model grades the top 30: what the desk runs
// A follow-up is written out in full by the same rewriter the desk uses (searchFor), and the graded
// search also runs follow-ups as asked, to show what the rewrite adds.
//
// The measures (written to docs/runs/search.json, compared by docs/measures.md):
//   recall_at_5        per answerable question: answering sections in the top 5, over min(answering, 5)
//   mrr                per answerable question: 1 / rank of the first answering section (0 past 10)
//   ndcg_at_10         graded gain 2^grade - 1, ideal order from the gold grades
//   out_of_label_empty per out-of-label question: 1 when the search returns nothing
import "../src/server/load-env";
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { createPool, migrate } from "../src/server/db";
import { env } from "../src/server/env";
import { embed, EMBEDDING_MODEL, useService } from "../src/server/gateway";
import { LABEL_SECTIONS, inForceDocuments, type LabelSection } from "../src/server/labels";
import { gradePassages } from "../src/server/rag/grade";
import { standaloneQuery, type Turn } from "../src/server/rag/rewrite";
import { CANDIDATES, hybridSearch } from "../src/server/rag/search";
import { LabelChunkStore } from "../src/server/rag/store";
import type { LabelSearch } from "../src/server/tools";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type Gold = {
  id: string;
  tenant_id: string;
  as_of: string;
  country: string;
  history: Turn[];
  query: string;
  kind: string;
  relevant: Array<{ doc_id: string; section: string; grade: 1 | 2 }>;
};

export type Scores = { recall_at_5: number; mrr: number; ndcg_at_10: number; out_of_label_empty: number };

const key = (docId: string, section: string) => `${docId} ${section}`;

// One question's scores against the ranked section keys a search returned.
export function scoreQuestion(gold: Gold, ranked: string[]): Partial<Scores> {
  if (gold.kind === "out_of_label") return { out_of_label_empty: ranked.length === 0 ? 1 : 0 };
  const grades = new Map(gold.relevant.map((r) => [key(r.doc_id, r.section), r.grade]));
  const answering = gold.relevant.filter((r) => r.grade === 2).map((r) => key(r.doc_id, r.section));
  const top5 = new Set(ranked.slice(0, 5));
  const recall = answering.filter((k) => top5.has(k)).length / Math.min(answering.length, 5);
  const first = ranked.slice(0, 10).findIndex((k) => grades.get(k) === 2);
  const gain = (grade: number) => 2 ** grade - 1;
  const dcg = ranked.slice(0, 10).reduce((sum, k, i) => sum + gain(grades.get(k) ?? 0) / Math.log2(i + 2), 0);
  const ideal = [...grades.values()].sort((a, b) => b - a).slice(0, 10).reduce((sum, g, i) => sum + gain(g) / Math.log2(i + 2), 0);
  return { recall_at_5: recall, mrr: first < 0 ? 0 : 1 / (first + 1), ndcg_at_10: ideal ? dcg / ideal : 0 };
}

const round = (value: number) => Math.round(value * 1000) / 1000;

export function average(rows: Array<Partial<Scores>>): Partial<Scores> {
  const out: Partial<Scores> = {};
  for (const name of ["recall_at_5", "mrr", "ndcg_at_10", "out_of_label_empty"] as const) {
    const values = rows.map((row) => row[name]).filter((v): v is number => v !== undefined);
    if (values.length) out[name] = round(values.reduce((a, b) => a + b, 0) / values.length);
  }
  return out;
}

// What a doctor of this company in this country may search (OpenFGA can_read: the company owns it
// and it is approved there). infra/openfga/model.fga holds the rule; this is the same rule over the
// library, so the measure needs no OpenFGA running.
function readableFor(gold: Gold): Set<string> {
  return new Set(LABEL_SECTIONS.filter((s) => s.tenantId === gold.tenant_id && s.country === gold.country).map((s) => s.docId));
}

// Runs a few questions at once: each graded search is one model call.
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

async function main() {
  if (!env.databaseUrl) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
  const spans = new LangfuseSpanProcessor();
  const sdk = new NodeSDK({ spanProcessors: [spans] });
  sdk.start();
  // Traces are a copy for reading, not the measure. On 2026-11-26 a trace upload timed out after
  // 160 of 178 questions and killed the run before it wrote a number. An upload failure is now a
  // warning; any other error still stops the run.
  const exportFailure = (error: unknown) => {
    if (error instanceof Error && error.stack?.includes("otlp-exporter-base")) {
      console.warn(`A trace upload failed (${error.message}); the measure goes on without that trace.`);
      return;
    }
    throw error;
  };
  process.on("unhandledRejection", exportFailure);
  process.on("uncaughtException", exportFailure);
  useService("eval-runner");
  const pool = createPool(env.databaseUrl);
  try {
    await migrate(pool);
    const store = new LabelChunkStore(pool);
    if (!(await store.count(EMBEDDING_MODEL))) throw new Error("The label index is empty. Run npm run rag:ingest first.");
    const golds = readFileSync(path.join(root, "data/hcp/gold/retrieval.jsonl"), "utf8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Gold);

    const vectors = new Map<string, Promise<number[]>>();
    const embedQuery = (text: string) => {
      if (!vectors.has(text)) vectors.set(text, embed([text]).then((v) => v[0]!));
      return vectors.get(text)!;
    };
    const dense: LabelSearch = async (query, readable, limit, today) => {
      const docs = [...inForceDocuments(readable, today)];
      const seen = new Set<string>();
      const out: LabelSection[] = [];
      for (const passage of await store.nearest(await embedQuery(query), docs, CANDIDATES, EMBEDDING_MODEL)) {
        if (seen.has(key(passage.docId, passage.section))) continue;
        seen.add(key(passage.docId, passage.section));
        out.push(passage);
        if (out.length === limit) break;
      }
      return out;
    };
    const searches: Record<string, LabelSearch> = {
      dense,
      hybrid: hybridSearch({ store, embedQuery }),
      graded: hybridSearch({ store, embedQuery, grade: gradePassages })
    };

    type Row = { id: string; kind: string; asked: string; runs: Record<string, string[]> };
    let done = 0;
    const rows = await mapLimit(golds, 4, async (gold): Promise<Row> => {
      const readable = readableFor(gold);
      const asked = await standaloneQuery(gold.query, gold.history);
      const runs: Record<string, string[]> = {};
      for (const [name, search] of Object.entries(searches)) {
        runs[name] = (await search(asked, readable, 10, gold.as_of)).map((s) => key(s.docId, s.section));
      }
      if (gold.history.length) runs.graded_as_asked = (await searches.graded!(gold.query, readable, 10, gold.as_of)).map((s) => key(s.docId, s.section));
      if (++done % 20 === 0) console.log(`${done} of ${golds.length} questions`);
      return { id: gold.id, kind: gold.kind, asked, runs };
    });

    const byId = new Map(golds.map((g) => [g.id, g]));
    const summary = (run: string, filter: (row: Row) => boolean = () => true) =>
      average(rows.filter((row) => filter(row) && row.runs[run]).map((row) => scoreQuestion(byId.get(row.id)!, row.runs[run]!)));
    const kinds = [...new Set(golds.map((g) => g.kind))];
    const configs = Object.fromEntries(
      ["dense", "hybrid", "graded"].map((run) => [
        run,
        { all: summary(run), by_kind: Object.fromEntries(kinds.map((kind) => [kind, summary(run, (row) => row.kind === kind)])) }
      ])
    );
    const followUps = {
      rewritten: summary("graded", (row) => row.kind === "follow_up"),
      as_asked: summary("graded_as_asked", (row) => row.kind === "follow_up")
    };
    const graded = configs.graded!.all;
    const misses = rows
      .filter((row) => {
        const s = scoreQuestion(byId.get(row.id)!, row.runs.graded!);
        return (s.recall_at_5 ?? 1) < 1 || s.out_of_label_empty === 0;
      })
      .map((row) => ({ id: row.id, kind: row.kind, asked: row.asked, got: row.runs.graded!.slice(0, 5) }));

    const run = {
      measures: {
        "search.recall_at_5": graded.recall_at_5,
        "search.mrr": graded.mrr,
        "search.ndcg_at_10": graded.ndcg_at_10,
        "search.out_of_label_empty": graded.out_of_label_empty
      },
      commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
      at: new Date().toISOString(),
      questions: golds.length,
      configs,
      follow_ups: followUps,
      misses
    };
    mkdirSync(path.join(root, "docs/runs"), { recursive: true });
    writeFileSync(path.join(root, "docs/runs/search.json"), `${JSON.stringify(run, null, 2)}\n`);
    for (const [name, config] of Object.entries(configs)) console.log(name.padEnd(7), JSON.stringify(config.all));
    console.log("follow-ups", JSON.stringify(followUps));
    console.log(`${misses.length} questions missed something; docs/runs/search.json lists them.`);
  } finally {
    await pool.end();
    await spans.forceFlush();
    await sdk.shutdown();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();

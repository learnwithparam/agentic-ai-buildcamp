// Lesson 21. npm run citations:measure: how well the claim check finds a claim the label does not
// support, on the 116 claim and quote pairs in data/hcp/gold/claims.jsonl.
//
// Each row is a claim, the quote that is offered for it, and a label: supported, or one way it can
// be wrong (unsupported, wrong_number, wrong_version, wrong_country, fabricated_quote). A row is
// flagged when the code checks fail (checkClaim) or the support judge says the quote does not
// support the claim. The code checks run first; the judge is asked about a claim they pass.
//
// The measures (written to docs/runs/citations.json, compared by docs/measures.md). The positive
// class is "not supported": every label except supported.
//   hallucination_precision  flagged rows that are not supported, over flagged rows
//   hallucination_recall     not-supported rows that are flagged, over not-supported rows
//   quote_verbatim_rate      rows with a real quote (every label but fabricated_quote) that the
//                            verbatim check accepts
//   true_answer_pass_rate    the other side: the dataset's own ideal answers, which are true and
//                            cited, each run LISTINGS times through the claim listing and the
//                            checks the app runs (claimCheckWith). A stop on one is a true answer
//                            the doctor would not get. An ideal answer the number check already
//                            stops (a number with no citation) is left out: that stop is right.
// Also written: how often the judge agrees with the label, per label (judge_by_label), and the
// rows the check got wrong (misses).
//
//   npm run citations:measure             the real model, through the gateway
//   npm run citations:measure -- --fake   no model: the judge repeats the row's label, so the
//                                         arithmetic and the code checks can be proven offline
import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkCitations, describeProblem, type RetrievedSection } from "../src/server/citations";
import { checkClaim, quoteIsVerbatim, type ClaimCheck, type Judge, type Verdict } from "../src/server/citations.claims";
import { LABEL_SECTIONS, statusOn, TODAY } from "../src/server/labels";
import { loadAllCases } from "./hcp-cases";
import { runMain } from "./run-main";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export type GoldClaim = {
  id: string;
  tenant_id: string;
  as_of: string;
  claim: string;
  doc_id: string;
  section: string;
  quote: string;
  label: string;
  country?: string;
};

export const readGold = (): GoldClaim[] =>
  readFileSync(path.join(root, "data/hcp/gold/claims.jsonl"), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as GoldClaim);

// What the judge is asked on a row, and what it should answer.
const expected = (row: GoldClaim): Verdict => (row.label === "supported" ? "supported" : "unsupported");

export type RowResult = { id: string; label: string; code: string | null; verbatim: boolean; judge: Verdict };

export async function runRow(row: GoldClaim, judge: Judge): Promise<RowResult> {
  const claim = { text: row.claim, quote: row.quote, docId: row.doc_id, section: row.section };
  // No search ran for a gold row, so the "a search returned it" rule is skipped; the row names the
  // country the asker is in when it matters.
  const code = checkClaim(claim, { retrieved: null, today: row.as_of, country: row.country });
  return { id: row.id, label: row.label, code, verbatim: quoteIsVerbatim(claim), judge: await judge(claim) };
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const ratio = (top: number, bottom: number) => (bottom ? round(top / bottom) : 0);

export function score(results: RowResult[]) {
  const flagged = (r: RowResult) => r.code !== null || r.judge === "unsupported";
  const positive = (r: RowResult) => r.label !== "supported";
  const truePositive = results.filter((r) => flagged(r) && positive(r)).length;
  const real = results.filter((r) => r.label !== "fabricated_quote");
  const labels = [...new Set(results.map((r) => r.label))].sort();
  const byLabel = Object.fromEntries(
    labels.map((label) => {
      const rows = results.filter((r) => r.label === label);
      const want: Verdict = label === "supported" ? "supported" : "unsupported";
      return [
        label,
        {
          rows: rows.length,
          flagged: rows.filter(flagged).length,
          flagged_by_code: rows.filter((r) => r.code !== null).length,
          judge_agrees: rows.filter((r) => r.judge === want).length,
          judge_agreement: ratio(rows.filter((r) => r.judge === want).length, rows.length)
        }
      ];
    })
  );
  return {
    hallucination_precision: ratio(truePositive, results.filter(flagged).length),
    hallucination_recall: ratio(truePositive, results.filter(positive).length),
    quote_verbatim_rate: ratio(real.filter((r) => r.verbatim).length, real.length),
    judge_agreement: ratio(results.filter((r) => r.judge === (r.label === "supported" ? "supported" : "unsupported")).length, results.length),
    by_label: byLabel,
    misses: results.filter((r) => flagged(r) !== positive(r)).map((r) => ({ id: r.id, label: r.label, code: r.code, judge: r.judge }))
  };
}

// The same judge call in both modes is asked on every row, so the judge's agreement is read on all
// of them, not only the rows the code checks let through.
export const labelJudge = (rows: GoldClaim[]): Judge => async ({ text, quote }) => {
  const row = rows.find((r) => r.claim === text && r.quote === quote);
  if (!row) throw new Error("--fake needs a gold row for every claim it judges.");
  return expected(row);
};

// The dataset's ideal answers for the cases that expect a cited reply, each with the sections it
// cites as the search results, so the claim listing sees what it would see in the app.
export type TrueAnswer = { caseId: string; answer: string; asked: string; retrieved: RetrievedSection[] };
const CITATION = /\[([a-z0-9-]+),\s*([\d.]+)\]/g;

export function trueAnswers(today = TODAY): TrueAnswer[] {
  return loadAllCases()
    .filter((item) => item.expectedOutput.expectedBehavior === "reply" && item.expectedOutput.idealAnswer.match(CITATION))
    .map((item) => {
      const answer = item.expectedOutput.idealAnswer;
      const cited = [...answer.matchAll(CITATION)].map(([, docId, section]) => `${docId}|${section}`);
      const retrieved = LABEL_SECTIONS.filter((s) => cited.includes(`${s.docId}|${s.section}`)).map((s) => ({ doc_id: s.docId, section: s.section, status: statusOn(s, today), text: s.text }));
      const asked = (item.input.messages as Array<{ role: string; content: string }>).filter((m) => m.role === "user").map((m) => m.content).join("\n");
      return { caseId: item.metadata.caseId, answer, asked, retrieved };
    })
    .filter((row) => checkCitations(row.answer, row.retrieved, row.asked, today).length === 0);
}

export const LISTINGS = 3;

export async function trueAnswerPassRate(check: ClaimCheck, rows = trueAnswers(), today = TODAY) {
  const runs = await Promise.all(rows.flatMap((row) => Array.from({ length: LISTINGS }, async () => ({ row, problems: await check(row.answer, row.retrieved, row.asked, today) }))));
  const stopped = runs.filter((run) => run.problems.length);
  return {
    rate: ratio(runs.length - stopped.length, runs.length),
    answers: rows.length,
    listings: runs.length,
    stopped: stopped.map((run) => ({ caseId: run.row.caseId, problems: run.problems.map(describeProblem) }))
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

async function main() {
  const fake = process.argv.includes("--fake");
  const rows = readGold();
  let judge: Judge;
  let truth: Awaited<ReturnType<typeof trueAnswerPassRate>> | undefined;
  if (fake) {
    judge = labelJudge(rows);
  } else {
    await import("../src/server/load-env");
    const { modelClient, useService } = await import("../src/server/gateway");
    const { judgeWithModel } = await import("../src/server/citations.claims");
    useService("eval-runner");
    judge = judgeWithModel(modelClient());
    const { claimCheckWith } = await import("../src/server/citations.claims");
    truth = await trueAnswerPassRate(claimCheckWith(modelClient()));
  }
  const results = await mapLimit(rows, 4, (row) => runRow(row, judge));
  const scored = score(results);
  const file = fake ? "citations.fake.json" : "citations.json";
  const run = {
    measures: {
      "citations.hallucination_precision": scored.hallucination_precision,
      "citations.hallucination_recall": scored.hallucination_recall,
      "citations.quote_verbatim_rate": scored.quote_verbatim_rate,
      // The listing needs the model, so --fake has no number for it.
      ...(truth ? { "citations.true_answer_pass_rate": truth.rate } : {})
    },
    commit: execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim(),
    at: new Date().toISOString(),
    rows: rows.length,
    judge: fake ? "label (--fake: no model was called)" : "gateway model",
    judge_agreement: scored.judge_agreement,
    judge_by_label: scored.by_label,
    misses: scored.misses,
    ...(truth ? { true_answers: { answers: truth.answers, listings: truth.listings, stopped: truth.stopped } } : {})
  };
  mkdirSync(path.join(root, "docs/runs"), { recursive: true });
  // --fake writes beside the real file, never over it: measures.md reads citations.json.
  writeFileSync(path.join(root, "docs/runs", file), `${JSON.stringify(run, null, 2)}\n`);
  console.log(JSON.stringify(run.measures));
  for (const [label, row] of Object.entries(scored.by_label)) console.log(label.padEnd(17), JSON.stringify(row));
  console.log(`judge agreement ${scored.judge_agreement}; ${scored.misses.length} rows wrong; docs/runs/${file}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runMain(main, { name: "Citations measure" });

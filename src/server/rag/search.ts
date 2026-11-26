import type pg from "pg";
import { embed, EMBEDDING_MODEL } from "../gateway";
import { LABEL_SECTIONS, inForceDocuments, statusOn, type LabelSection } from "../labels";
import { useLabelSearch, type LabelSearch } from "../tools";
import { gradePassages, type Grader } from "./grade";
import { LabelChunkStore, type RankedPassage } from "./store";

// Lesson 20. search_labels in four steps, the way PaperQA2 finds evidence in papers:
//   1. Only documents in force on the day, among those the asker may read. An old version is
//      never a candidate, so it can never be cited (label_versions answers questions about history).
//   2. Two searches: by meaning (pgvector) and by words (BM25). "A mother who is nursing" shares no
//      word with 8.2 Lactation but sits close to it as a vector; "36 hours" and "CYP3A4" are words a
//      vector blurs, and BM25 finds them exactly.
//   3. The two rankings are fused by reciprocal rank: a passage high in either list rises.
//   4. The model grades each search's top sections against the question. No section graded as answering
//      means the library does not answer it, and the search says so with no results.
// docs/measures.md holds what each step is worth on the gold questions (npm run search:measure).

// How many passages each search hands to the fusion, and the RRF constant from Cormack et al.
export const CANDIDATES = 50;
export const RRF_K = 60;
// How many sections the model grades: the top 15 of each search (candidatePool).
export const GRADED = 30;
// A section must grade at least this to be an answer (3 states it, 2 states part or the rule).
export const ANSWERS = 2;

export type SearchStores = Pick<LabelChunkStore, "nearest" | "keyword">;
export type SearchOptions = {
  store: SearchStores;
  embedQuery?: (text: string) => Promise<number[]>;
  // Leave out to rank by fusion alone, which is how the measure shows what grading adds.
  grade?: Grader;
  model?: string;
};

export type Candidate = { section: LabelSection; passage: RankedPassage; fused: number; dense?: number; keyword?: number };

const key = (row: { docId: string; section: string }) => `${row.docId} ${row.section}`;

// Reciprocal rank fusion over passages, then one entry per section: its best passage.
export function fuse(dense: RankedPassage[], keyword: RankedPassage[]): Array<Omit<Candidate, "section">> {
  const byPassage = new Map<string, Omit<Candidate, "section">>();
  const add = (list: RankedPassage[], which: "dense" | "keyword") =>
    list.forEach((passage, rank) => {
      const id = `${key(passage)} ${passage.part}`;
      const entry = byPassage.get(id) ?? { passage, fused: 0 };
      entry.fused += 1 / (RRF_K + rank + 1);
      entry[which] = rank + 1;
      byPassage.set(id, entry);
    });
  add(dense, "dense");
  add(keyword, "keyword");
  const best = new Map<string, Omit<Candidate, "section">>();
  for (const entry of [...byPassage.values()].sort((a, b) => b.fused - a.fused)) {
    if (!best.has(key(entry.passage))) best.set(key(entry.passage), entry);
  }
  return [...best.values()];
}

// The sections the model grades: the first n of the two searches taken in turn (vector first,
// then BM25, then the second of each), in fused order. Fusion alone cuts the wrong ones. When
// one search matches nearly everything (BM25 on "take" in one label), every section both lists
// hold outscores a section only one found, even the vector search's first. Measured: "Can a
// mother who is nursing her baby take CardioNex?" ranked 8.2 Lactation first by meaning, and
// fusion put it 31st. The grader reranks anyway, so the pool only has to hold the answer.
export function candidatePool(dense: RankedPassage[], keyword: RankedPassage[], n: number): Array<Omit<Candidate, "section">> {
  const lists = [dense, keyword].map((list) => [...new Set(list.map(key))]);
  const chosen = new Set<string>();
  for (let rank = 0; chosen.size < n && lists.some((list) => rank < list.length); rank++) {
    for (const list of lists) if (rank < list.length && chosen.size < n) chosen.add(list[rank]!);
  }
  return fuse(dense, keyword).filter((entry) => chosen.has(key(entry.passage)));
}

const round = (value: number) => Math.round(value * 10000) / 10000;

export function hybridSearch(options: SearchOptions): LabelSearch {
  const model = options.model ?? EMBEDDING_MODEL;
  const embedQuery = options.embedQuery ?? (async (text: string) => (await embed([text]))[0]);
  return async (query, readable, limit, today) => {
    const docs = [...inForceDocuments(readable, today)];
    if (!docs.length || !query.trim()) return [];
    const [dense, keyword] = await Promise.all([
      embedQuery(query).then((vector) => options.store.nearest(vector, docs, CANDIDATES, model)),
      options.store.keyword(query, docs, CANDIDATES, model)
    ]);
    const candidates = candidatePool(dense, keyword, GRADED)
      .map((entry): Candidate => ({ ...entry, section: sectionText(entry.passage, today) }));
    const scores = (candidate: Candidate, grade?: number) => ({
      fused: round(candidate.fused),
      ...(candidate.dense ? { dense_rank: candidate.dense } : {}),
      ...(candidate.keyword ? { keyword_rank: candidate.keyword } : {}),
      ...(grade === undefined ? {} : { grade })
    });
    if (!options.grade) return candidates.slice(0, limit).map((candidate) => ({ ...candidate.section, scores: scores(candidate) }));
    const { grades, best } = await options.grade(
      query,
      candidates.map(({ passage }) => ({
        source: `${passage.docId} (${passage.brandId}, ${passage.country})`,
        path: passage.path,
        text: passage.text
      }))
    );
    if (!grades.some((grade) => grade >= ANSWERS)) return [];
    // The grader's best order first, then any other answer by grade, then the sections that only
    // help; among equal places the fused order stands.
    const place = (i: number) => {
      const at = best.indexOf(i);
      return at >= 0 ? at : best.length + (3 - grades[i]!);
    };
    return candidates
      .map((candidate, i) => ({ candidate, grade: grades[i]!, place: place(i) }))
      .filter(({ grade }) => grade >= 1)
      .sort((a, b) => a.place - b.place)
      .slice(0, limit)
      .map(({ candidate, grade }) => ({ ...candidate.section, score: grade, scores: scores(candidate, grade) }));
  };
}

// A result is the whole section the passage came from, as the label prints it, so the agent
// reads (and cites) the section, not a cut of it. Ingest proved the PDF holds the same words.
function sectionText(passage: RankedPassage, today: string): LabelSection {
  const whole = LABEL_SECTIONS.find((section) => section.docId === passage.docId && section.section === passage.section);
  if (!whole) throw new Error(`The index holds ${passage.docId} ${passage.section}, which data/hcp does not. Run npm run rag:ingest.`);
  return { ...whole, status: statusOn(whole, today) };
}

// The server and the dataset runner call this once at start. An empty index is a setup step
// not yet done, so it stops here with the command that does it, rather than answering from nothing.
export async function connectLabelIndex(pool: pg.Pool): Promise<number> {
  const store = new LabelChunkStore(pool);
  const passages = await store.count(EMBEDDING_MODEL);
  if (!passages) throw new Error(`The label index has no passages from ${EMBEDDING_MODEL}. Run npm run rag:ingest (lesson 20).`);
  useLabelSearch(hybridSearch({ store, grade: gradePassages }));
  return passages;
}

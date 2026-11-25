import type pg from "pg";
import { embed, EMBEDDING_MODEL } from "../gateway";
import { statusOn, type LabelSection } from "../labels";
import { useLabelSearch, type LabelSearch } from "../tools";
import { LabelChunkStore } from "./store";

// Lesson 20. search_labels by meaning, not by shared words. "A mother who is nursing" shares no
// word with section 8.2 "Lactation"; their vectors sit close together.

// Below this cosine similarity a section is not about the question at all. Measured on this
// library with text-embedding-3-small over every dataset question: the best section for each real
// question scores 0.48 or more, and for the request to write a scraper (GUARDRAIL-01) 0.26.
// A floor cannot tell "about CardioNex but not in the label" from an answer: the alcohol question
// (RAG-03) scores 0.60 on the boxed warning. Saying the label is silent stays the agent's job.
export const MIN_SIMILARITY = 0.35;

// How many nearest sections to read for each one returned. Each version of a label has a section
// with almost the same text, so the nearest few can all be versions no longer in force (AUTO-01:
// v1, v2 and v2 again, with v3 2.2 just behind them). Reading more, then putting the sections in
// force first, keeps the one the agent may cite in the results, and the old ones after it.
export const CANDIDATES_PER_RESULT = 4;

export function vectorSearch(
  store: Pick<LabelChunkStore, "nearest">,
  embedQuery: (text: string) => Promise<number[]> = async (text) => (await embed([text]))[0],
  minSimilarity = MIN_SIMILARITY,
  model = EMBEDDING_MODEL
): LabelSearch {
  return async (query, readable, limit, today) => {
    if (!readable.size || !query.trim()) return [];
    const hits = await store.nearest(await embedQuery(query), [...readable], limit * CANDIDATES_PER_RESULT, model);
    const sections = hits
      .filter((hit) => hit.similarity >= minSimilarity)
      .map(({ similarity: _similarity, ...section }): LabelSection => ({ ...section, status: statusOn(section, today) }));
    // A stable sort: in force first, each group still nearest first.
    const inForce = (section: LabelSection) => (section.status === "active" ? 0 : 1);
    return sections.sort((a, b) => inForce(a) - inForce(b)).slice(0, limit);
  };
}

// The server and the dataset runner call this once at start. An empty index is a setup step
// not yet done, so it stops here with the command that does it, rather than answering from nothing.
export async function connectLabelIndex(pool: pg.Pool): Promise<number> {
  const store = new LabelChunkStore(pool);
  const sections = await store.count(EMBEDDING_MODEL);
  if (!sections) throw new Error(`The label index has no sections from ${EMBEDDING_MODEL}. Run npm run rag:ingest (lesson 20).`);
  useLabelSearch(vectorSearch(store));
  return sections;
}

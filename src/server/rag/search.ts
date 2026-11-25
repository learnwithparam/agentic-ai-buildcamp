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

export function vectorSearch(
  store: Pick<LabelChunkStore, "nearest">,
  embedQuery: (text: string) => Promise<number[]> = async (text) => (await embed([text]))[0],
  minSimilarity = MIN_SIMILARITY,
  model = EMBEDDING_MODEL
): LabelSearch {
  return async (query, readable, limit, today) => {
    if (!readable.size || !query.trim()) return [];
    const hits = await store.nearest(await embedQuery(query), [...readable], limit, model);
    return hits
      .filter((hit) => hit.similarity >= minSimilarity)
      .map(({ similarity: _similarity, ...section }): LabelSection => ({ ...section, status: statusOn(section, today) }));
  };
}

// The server and the dataset runner call this once at start. An empty index is a setup step
// not yet done, so it stops here with the command that does it, rather than answering from nothing.
export async function connectLabelIndex(pool: pg.Pool): Promise<number> {
  const store = new LabelChunkStore(pool);
  const sections = await store.count(EMBEDDING_MODEL);
  if (!sections) throw new Error("The label index is empty. Run npm run rag:ingest (lesson 20).");
  useLabelSearch(vectorSearch(store));
  return sections;
}

import type pg from "pg";
import type { LabelSection } from "../labels";

// Lesson 20. The label_chunks table (migrations 008 and 011): one row per passage of each label
// PDF. Every query names the embedding model, so a vector made by another model is never compared.

export type LabelChunk = LabelSection & { part: number; path: string; embedding: number[] };
export type RankedPassage = LabelSection & { part: number; path: string; score: number };

// pgvector reads a vector as text: [0.1,0.2,...].
const asVector = (values: number[]) => `[${values.join(",")}]`;

const COLUMNS = `doc_id AS "docId", section, part, path, title, text, tenant_id AS "tenantId", brand_id AS "brandId",
  status, effective_date AS "effectiveDate", country`;

// BM25 with the usual constants: k1 says how fast a repeated word stops adding, b how much a long
// passage is held back.
const K1 = 1.2;
const B = 0.75;

export class LabelChunkStore {
  constructor(private readonly pool: pg.Pool) {}

  // What a document was last ingested from, so ingest can skip it when nothing changed.
  async ingestedFrom(docId: string): Promise<{ pdfSha256: string; model: string; chunker: string } | null> {
    const { rows } = await this.pool.query<{ pdfSha256: string; model: string; chunker: string }>(
      `SELECT pdf_sha256 AS "pdfSha256", embedding_model AS model, chunker FROM label_chunks WHERE doc_id = $1 LIMIT 1`,
      [docId]
    );
    return rows[0] ?? null;
  }

  // A document's passages are replaced together, in one transaction: a search never sees half
  // of an old version and half of a new one.
  async replaceDocument(docId: string, chunks: LabelChunk[], pdfSha256: string, model: string, chunker: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM label_chunks WHERE doc_id = $1", [docId]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO label_chunks (doc_id, section, part, path, title, text, tenant_id, brand_id, status, effective_date, country,
             pdf_sha256, embedding_model, chunker, embedding, term_count)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::vector,
             (SELECT coalesce(sum(array_length(positions, 1)), 0) FROM unnest(to_tsvector('english', $4 || ' ' || $5 || ' ' || $6))))`,
          [docId, chunk.section, chunk.part, chunk.path, chunk.title, chunk.text, chunk.tenantId, chunk.brandId, chunk.status,
            chunk.effectiveDate, chunk.country, pdfSha256, model, chunker, asVector(chunk.embedding)]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // A document no longer in the library leaves the index too.
  async keepOnly(docIds: string[]): Promise<number> {
    const result = await this.pool.query("DELETE FROM label_chunks WHERE NOT (doc_id = ANY($1))", [docIds]);
    return result.rowCount ?? 0;
  }

  async count(model: string): Promise<number> {
    const { rows } = await this.pool.query<{ n: string }>("SELECT count(*) AS n FROM label_chunks WHERE embedding_model = $1", [model]);
    return Number(rows[0].n);
  }

  // The passages nearest the question by meaning, among the given documents. The filter is in
  // the query, so a passage the asker may not read is never a candidate. strict_order makes the
  // HNSW index keep scanning until it has enough rows that pass the filter, still in order.
  async nearest(query: number[], docIds: string[], limit: number, model: string): Promise<RankedPassage[]> {
    if (!docIds.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
      const { rows } = await client.query<RankedPassage>(
        `SELECT ${COLUMNS}, 1 - (embedding <=> $1::vector) AS score
         FROM label_chunks
         WHERE embedding_model = $4 AND doc_id = ANY($2)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [asVector(query), docIds, limit, model]
      );
      await client.query("COMMIT");
      return rows.map((row) => ({ ...row, score: Number(row.score) }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  // The passages that share the most telling words with the question, scored by BM25. Any word
  // may match (an OR of the question's stemmed words); a rare word such as "ketoconazole" counts
  // far more than a common one such as "patients". How rare a word is, and how long a passage is
  // on average, are counted over the whole library, so a score does not depend on who asks.
  async keyword(query: string, docIds: string[], limit: number, model: string): Promise<RankedPassage[]> {
    if (!docIds.length || !query.trim()) return [];
    const { rows } = await this.pool.query<RankedPassage>(
      `WITH asked AS (
         SELECT DISTINCT unnest(tsvector_to_array(to_tsvector('english', $1))) AS term
       ),
       library AS (
         SELECT count(*)::float AS n, greatest(avg(term_count), 1)::float AS avg_len FROM label_chunks WHERE embedding_model = $4
       ),
       postings AS (
         SELECT c.doc_id, c.section, c.part, c.term_count, w.lexeme AS term, array_length(w.positions, 1)::float AS tf
         FROM label_chunks c, unnest(c.terms) AS w
         WHERE c.embedding_model = $4 AND w.lexeme IN (SELECT term FROM asked)
       ),
       rarity AS (
         SELECT term, ln(1 + (library.n - count(*) + 0.5) / (count(*) + 0.5)) AS idf FROM postings, library GROUP BY term, library.n
       ),
       scored AS (
         SELECT p.doc_id, p.section, p.part,
           sum(r.idf * p.tf * ${K1 + 1} / (p.tf + ${K1} * (1 - ${B} + ${B} * p.term_count / l.avg_len))) AS score
         FROM postings p JOIN rarity r USING (term), library l
         WHERE p.doc_id = ANY($2)
         GROUP BY p.doc_id, p.section, p.part
         ORDER BY score DESC
         LIMIT $3
       )
       SELECT ${COLUMNS}, s.score
       FROM scored s JOIN label_chunks c USING (doc_id, section, part)
       WHERE c.embedding_model = $4
       ORDER BY s.score DESC`,
      [query, docIds, limit, model]
    );
    return rows.map((row) => ({ ...row, score: Number(row.score) }));
  }
}

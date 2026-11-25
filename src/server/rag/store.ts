import type pg from "pg";
import type { LabelSection } from "../labels";

// Lesson 20. The label_chunks table (migration 008): one row per section of each label PDF.
// Every query names the embedding model, so a vector made by another model is never compared.

export type LabelChunk = LabelSection & { embedding: number[] };
export type ScoredSection = LabelSection & { similarity: number };

// pgvector reads a vector as text: [0.1,0.2,...].
const asVector = (values: number[]) => `[${values.join(",")}]`;

const COLUMNS = `doc_id AS "docId", section, title, text, tenant_id AS "tenantId", brand_id AS "brandId",
  status, effective_date AS "effectiveDate", country`;

export class LabelChunkStore {
  constructor(private readonly pool: pg.Pool) {}

  // What a document was last ingested from, so ingest can skip it when nothing changed.
  async ingestedFrom(docId: string): Promise<{ pdfSha256: string; model: string } | null> {
    const { rows } = await this.pool.query<{ pdfSha256: string; model: string }>(
      `SELECT pdf_sha256 AS "pdfSha256", embedding_model AS model FROM label_chunks WHERE doc_id = $1 LIMIT 1`,
      [docId]
    );
    return rows[0] ?? null;
  }

  // A document's sections are replaced together, in one transaction: a search never sees half
  // of an old version and half of a new one.
  async replaceDocument(docId: string, chunks: LabelChunk[], pdfSha256: string, model: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM label_chunks WHERE doc_id = $1", [docId]);
      for (const chunk of chunks) {
        await client.query(
          `INSERT INTO label_chunks (doc_id, section, title, text, tenant_id, brand_id, status, effective_date, country,
             pdf_sha256, embedding_model, embedding)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::vector)`,
          [docId, chunk.section, chunk.title, chunk.text, chunk.tenantId, chunk.brandId, chunk.status, chunk.effectiveDate,
            chunk.country, pdfSha256, model, asVector(chunk.embedding)]
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

  // The sections nearest the question, among the documents the asker may read. The filter is in
  // the query, so a section the asker may not read is never a candidate. strict_order makes the
  // HNSW index keep scanning until it has enough rows that pass the filter, still in order.
  // Every section of the given documents that are short in total, in section order. A short
  // procedure or FAQ is read whole: its sections answer one question together.
  async shortDocuments(docIds: string[], maxWords: number, model: string): Promise<LabelSection[]> {
    if (!docIds.length) return [];
    const { rows } = await this.pool.query<LabelSection>(
      `SELECT ${COLUMNS} FROM label_chunks
       WHERE embedding_model = $3 AND doc_id IN (
         SELECT doc_id FROM label_chunks WHERE embedding_model = $3 AND doc_id = ANY($1)
         GROUP BY doc_id HAVING sum(array_length(regexp_split_to_array(trim(text), '\\s+'), 1)) <= $2)
       ORDER BY doc_id, string_to_array(section, '.')::int[]`,
      [docIds, maxWords, model]
    );
    return rows;
  }

  async nearest(query: number[], readable: string[], limit: number, model: string): Promise<ScoredSection[]> {
    if (!readable.length) return [];
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL hnsw.iterative_scan = strict_order");
      const { rows } = await client.query<ScoredSection>(
        `SELECT ${COLUMNS}, 1 - (embedding <=> $1::vector) AS similarity
         FROM label_chunks
         WHERE embedding_model = $4 AND doc_id = ANY($2)
         ORDER BY embedding <=> $1::vector
         LIMIT $3`,
        [asVector(query), readable, limit, model]
      );
      await client.query("COMMIT");
      return rows.map((row) => ({ ...row, similarity: Number(row.similarity) }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

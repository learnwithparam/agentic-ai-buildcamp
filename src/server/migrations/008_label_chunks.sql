-- Lesson 20. The label library as vectors: one row per section of each PDF, with the section's
-- text as Docling read it and the vector the gateway's embedding model made of it.
-- The vector extension is installed by the database owner, not this app's role: on a database made
-- before lesson 20, npm run rag:setup does it once.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'vector') THEN
    RAISE EXCEPTION 'The vector extension is not installed in this database. Run npm run rag:setup (lesson 20).';
  END IF;
END
$$;

CREATE TABLE label_chunks (
  doc_id text NOT NULL,
  section text NOT NULL,
  title text NOT NULL,
  text text NOT NULL,
  tenant_id text NOT NULL,
  brand_id text NOT NULL,
  status text NOT NULL,
  effective_date text NOT NULL,
  country text NOT NULL,
  -- The PDF the rows were read from, and the model that made the vector. Ingest skips a document
  -- whose rows already carry both, so a second run costs nothing.
  pdf_sha256 text NOT NULL,
  embedding_model text NOT NULL,
  embedding vector(1536) NOT NULL,
  ingested_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (doc_id, section)
);

-- Cosine distance, the measure the embedding model is trained for. HNSW answers a nearest-neighbour
-- query without reading every row once the library grows past a few hundred sections.
CREATE INDEX label_chunks_embedding ON label_chunks USING hnsw (embedding vector_cosine_ops);

-- Hybrid search over the label library. A long section is split into passages, so one row is now
-- one passage: (doc_id, section, part). A doctor still cites the section; the part only says which
-- passage of it matched.
ALTER TABLE label_chunks ADD COLUMN part integer NOT NULL DEFAULT 0;
ALTER TABLE label_chunks DROP CONSTRAINT label_chunks_pkey;
ALTER TABLE label_chunks ADD PRIMARY KEY (doc_id, section, part);

-- The headings above the section, for example "5 Warnings and Precautions > 5.3 Hyperkalemia",
-- so a passage of a long section still says what it is about.
ALTER TABLE label_chunks ADD COLUMN path text NOT NULL DEFAULT '';

-- How the passages were cut. Ingest re-reads a PDF whose rows were cut another way, even when the
-- PDF itself has not changed.
ALTER TABLE label_chunks ADD COLUMN chunker text NOT NULL DEFAULT '';

-- The words of the passage, stemmed, for keyword search. The vector finds "a nursing mother"
-- in 8.2 Lactation; the words find "36 hours" and "CYP3A4", which a vector blurs.
ALTER TABLE label_chunks ADD COLUMN terms tsvector
  GENERATED ALWAYS AS (to_tsvector('english', path || ' ' || title || ' ' || text)) STORED;
-- How many words the passage has once stop words are dropped: BM25 scores a match in a short
-- passage above the same match in a long one.
ALTER TABLE label_chunks ADD COLUMN term_count integer NOT NULL DEFAULT 0;
CREATE INDEX label_chunks_terms ON label_chunks USING gin (terms);

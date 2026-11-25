-- Lesson 14. Since an item's id comes from its content, two people can raise the same item: a rep
-- checks an email, then a medical reviewer checks the same text. Every request is a row here, and
-- nobody who asked for an item may decide it, not only the first to ask.
CREATE TABLE review_requests (
  item_id text NOT NULL REFERENCES review_items (id) ON DELETE CASCADE,
  thread_id text NOT NULL REFERENCES threads (thread_id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (item_id, thread_id)
);
CREATE INDEX review_requests_thread_id ON review_requests (thread_id);
INSERT INTO review_requests (item_id, thread_id) SELECT id, thread_id FROM review_items;

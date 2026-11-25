-- Lesson 14. Two more kinds of waiting item: an email the fact-checker flagged, for a medical
-- reviewer, and an outreach step, for a sales rep. Each sits on a thread owned by whoever asked,
-- so nobody approves their own.
ALTER TABLE review_items DROP CONSTRAINT review_items_kind_check;
ALTER TABLE review_items ADD CONSTRAINT review_items_kind_check CHECK (kind IN ('draft', 'adverse_event', 'email', 'outreach'));

-- Step 2B. How the item's answer was made (src/shared/run.ts): the tier and why, the sections it
-- rests on, and the citation check. The reviewer reads it beside the draft, so they decide with
-- the evidence in view. Null for items that no chat answer made (an email, an outreach step).
ALTER TABLE review_items ADD COLUMN run jsonb;

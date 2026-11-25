-- Lesson 22. Sales data for the insights agent, in two layers.
--
-- sales.prescriptions holds the rows each company's data vendor sends, as sent: one prescriber per
-- row, with an NPI (Pharma A) or an email (Pharma B). Only this app's own role can touch it. The
-- agent's logins get no grant on the schema, so a query that names it fails with "permission denied".
--
-- bi.territory_rx is what the agent reads: totals per company, period, territory and brand, built from
-- the rows above by npm run bi:setup. It has no prescriber column, and a group of fewer than 11
-- prescribers is left out, so no answer can point at one doctor.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_pharma_a')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'bi_pharma_b') THEN
    RAISE EXCEPTION 'The insights logins bi_pharma_a and bi_pharma_b do not exist. Run npm run bi:setup (lesson 22).';
  END IF;
END
$$;

CREATE SCHEMA sales;
REVOKE ALL ON SCHEMA sales FROM PUBLIC;

CREATE TABLE sales.prescriptions (
  tenant_id text NOT NULL,
  -- Pharma A sends weeks (the Monday), Pharma B sends months (the 1st). Neither is turned into the
  -- other: spreading a month over its weeks would invent numbers no vendor sent.
  period_start date NOT NULL,
  grain text NOT NULL CHECK (grain IN ('week', 'month')),
  territory text NOT NULL,
  brand text NOT NULL,
  prescriber text NOT NULL,
  trx integer NOT NULL,
  -- New prescriptions. Pharma B's file has none, and units shipped instead.
  nbrx integer,
  units integer,
  PRIMARY KEY (tenant_id, period_start, territory, brand, prescriber)
);

CREATE SCHEMA bi;
REVOKE ALL ON SCHEMA bi FROM PUBLIC;

CREATE TABLE bi.territory_rx (
  tenant_id text NOT NULL,
  period_start date NOT NULL,
  grain text NOT NULL,
  territory text NOT NULL,
  brand text NOT NULL,
  trx integer NOT NULL,
  nbrx integer,
  units integer,
  prescribers integer NOT NULL,
  PRIMARY KEY (tenant_id, period_start, territory, brand)
);

-- The row rule. Each login is named bi_<company> and sees that company's rows. current_user is set
-- when the login signs in, so no setting a query can change moves it.
-- FORCE puts this app's own role under the rule too: code that reads the table on the wrong pool gets
-- no rows, not every company's rows.
ALTER TABLE bi.territory_rx ENABLE ROW LEVEL SECURITY;
ALTER TABLE bi.territory_rx FORCE ROW LEVEL SECURITY;
CREATE POLICY own_company ON bi.territory_rx FOR SELECT USING (current_user = 'bi_' || tenant_id);
-- The app's role fills the table (npm run bi:setup) and reads none of it back.
CREATE POLICY loader ON bi.territory_rx FOR INSERT TO CURRENT_USER WITH CHECK (true);

GRANT USAGE ON SCHEMA bi TO bi_pharma_a, bi_pharma_b;
GRANT SELECT ON bi.territory_rx TO bi_pharma_a, bi_pharma_b;

-- Lesson 17. The limits the nightly sweep works within, one row per company, and a log of every
-- run. A row is made the first time anyone reads or changes a company's limits.
--   paused: the kill switch. The sweep reads it before every step, so a pause stops a run at once.
--   daily_budget_usd: what the sweep may spend in a day, measured in Langfuse.
CREATE TABLE agent_controls (
  tenant_id text PRIMARY KEY,
  paused boolean NOT NULL DEFAULT false,
  daily_budget_usd numeric(10, 4) NOT NULL DEFAULT 0.50 CHECK (daily_budget_usd >= 0),
  changed_by text,
  changed_at timestamptz
);

CREATE TABLE sweep_runs (
  run_id text PRIMARY KEY,
  tenant_id text NOT NULL,
  trigger text NOT NULL CHECK (trigger IN ('schedule', 'person')),
  requested_by text,
  instruction text,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'budget_stop', 'paused', 'failed')),
  steps integer NOT NULL DEFAULT 0,
  spent_usd numeric(12, 6),
  report text,
  item_ids text[] NOT NULL DEFAULT '{}',
  trace_id text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX sweep_runs_tenant_started ON sweep_runs (tenant_id, started_at DESC);

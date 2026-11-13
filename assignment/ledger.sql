-- One payment per run. The unique key on run_id is what makes a second payment impossible.
create table if not exists payments (
  run_id text primary key,
  amount_usd integer not null,
  paid_at timestamptz not null default now()
);

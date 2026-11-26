-- One row per chat turn a signed-in user asked, so the per-user limits hold across restarts and
-- across several server processes. Old rows are removed as new ones arrive (src/server/ops/limits.ts).
CREATE TABLE chat_turns (
  id bigserial PRIMARY KEY,
  user_id text NOT NULL,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX chat_turns_user_at ON chat_turns (user_id, at DESC);

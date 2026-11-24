-- Lesson 11. One row per signed-in browser. The cookie holds a random id; this table holds only
-- its SHA-256, so a copy of the table cannot be replayed as a cookie.
CREATE TABLE sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL,
  access_token text NOT NULL,
  refresh_token text,
  id_token text,
  access_expires_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_id ON sessions (user_id);
CREATE INDEX sessions_expires_at ON sessions (expires_at);

-- A sign-in that has left for Keycloak and not come back yet: the PKCE verifier, state and nonce.
CREATE TABLE pending_logins (
  id_hash text PRIMARY KEY,
  code_verifier text NOT NULL,
  state text NOT NULL,
  nonce text NOT NULL,
  return_to text NOT NULL DEFAULT '/',
  expires_at timestamptz NOT NULL
);

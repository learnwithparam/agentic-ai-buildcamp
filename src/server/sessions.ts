import { createHash, randomBytes } from "node:crypto";
import type pg from "pg";

// Lesson 11. Server-side sessions. The browser holds a random id in an HttpOnly cookie; the
// tokens Keycloak issued stay here and never reach the page's JavaScript.

export type Session = {
  userId: string;
  accessToken: string;
  refreshToken: string | null;
  idToken: string | null;
  accessExpiresAt: Date;
  expiresAt: Date;
};

export type PendingLogin = { codeVerifier: string; state: string; nonce: string; returnTo: string; expiresAt: Date };

export interface SessionStore {
  create(session: Session): Promise<string>;
  get(id: string): Promise<Session | null>;
  updateTokens(id: string, tokens: Pick<Session, "accessToken" | "refreshToken" | "idToken" | "accessExpiresAt">): Promise<void>;
  delete(id: string): Promise<void>;
  createPending(login: PendingLogin): Promise<string>;
  // Read once: a callback replayed with the same cookie finds nothing.
  takePending(id: string): Promise<PendingLogin | null>;
}

export const newId = () => randomBytes(32).toString("base64url");
export const hashId = (id: string) => createHash("sha256").update(id).digest("hex");

export class PostgresSessionStore implements SessionStore {
  constructor(private readonly pool: pg.Pool) {}

  async create(session: Session) {
    const id = newId();
    await this.pool.query(
      `INSERT INTO sessions (id_hash, user_id, access_token, refresh_token, id_token, access_expires_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [hashId(id), session.userId, session.accessToken, session.refreshToken, session.idToken, session.accessExpiresAt, session.expiresAt]
    );
    return id;
  }

  async get(id: string) {
    const { rows } = await this.pool.query(
      `SELECT user_id, access_token, refresh_token, id_token, access_expires_at, expires_at
       FROM sessions WHERE id_hash = $1 AND expires_at > now()`,
      [hashId(id)]
    );
    const row = rows[0];
    if (!row) return null;
    return {
      userId: row.user_id,
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      idToken: row.id_token,
      accessExpiresAt: row.access_expires_at,
      expiresAt: row.expires_at
    };
  }

  async updateTokens(id: string, tokens: Pick<Session, "accessToken" | "refreshToken" | "idToken" | "accessExpiresAt">) {
    await this.pool.query(
      `UPDATE sessions SET access_token = $2, refresh_token = $3, id_token = COALESCE($4, id_token), access_expires_at = $5
       WHERE id_hash = $1`,
      [hashId(id), tokens.accessToken, tokens.refreshToken, tokens.idToken, tokens.accessExpiresAt]
    );
  }

  async delete(id: string) {
    await this.pool.query("DELETE FROM sessions WHERE id_hash = $1", [hashId(id)]);
  }

  async createPending(login: PendingLogin) {
    const id = newId();
    await this.pool.query(
      "INSERT INTO pending_logins (id_hash, code_verifier, state, nonce, return_to, expires_at) VALUES ($1, $2, $3, $4, $5, $6)",
      [hashId(id), login.codeVerifier, login.state, login.nonce, login.returnTo, login.expiresAt]
    );
    // Old abandoned sign-ins are cleared as new ones start.
    await this.pool.query("DELETE FROM pending_logins WHERE expires_at < now()");
    return id;
  }

  async takePending(id: string) {
    const { rows } = await this.pool.query(
      "DELETE FROM pending_logins WHERE id_hash = $1 RETURNING code_verifier, state, nonce, return_to, expires_at",
      [hashId(id)]
    );
    const row = rows[0];
    if (!row || row.expires_at < new Date()) return null;
    return { codeVerifier: row.code_verifier, state: row.state, nonce: row.nonce, returnTo: row.return_to, expiresAt: row.expires_at };
  }
}

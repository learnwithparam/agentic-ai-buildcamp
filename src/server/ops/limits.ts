import type { RequestHandler } from "express";
import type pg from "pg";
import type { Identity } from "../users";

// Per-user limits on the chat API. Each turn is a row in Postgres (migration 013), so the count
// holds across restarts and across server processes. Two limits: a short burst limit, and a cap
// on turns in a day. The counts and the reason stay on the server; the user reads one sentence.
export type ChatLimits = { perMinute: number; perDay: number };
export const CHAT_LIMITS: ChatLimits = { perMinute: 10, perDay: 200 };

export const LIMIT_MESSAGE = "You have asked a lot of questions in a short time. Please wait a little, then try again.";

export type Allowed = { allowed: true } | { allowed: false; retryAfterSeconds: number };

export class ChatLimiter {
  constructor(
    private pool: pg.Pool,
    private limits: ChatLimits = CHAT_LIMITS
  ) {}

  // Counts the turn and says whether it may run. A refused turn is not counted, so waiting works.
  // `now` is a parameter so a test can move the clock; the server leaves it out.
  async take(userId: string, now: Date = new Date()): Promise<Allowed> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // One user's checks run one at a time, or two requests could both read "9 of 10".
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`chat_turns:${userId}`]);
      const { rows } = await client.query<{ minute: string; day: string; oldest_minute: Date | null; oldest_day: Date | null }>(
        `SELECT count(*) FILTER (WHERE at > $2::timestamptz - interval '1 minute') AS minute,
                count(*) AS day,
                min(at) FILTER (WHERE at > $2::timestamptz - interval '1 minute') AS oldest_minute,
                min(at) AS oldest_day
         FROM chat_turns WHERE user_id = $1 AND at > $2::timestamptz - interval '1 day' AND at <= $2::timestamptz`,
        [userId, now]
      );
      const { minute, day, oldest_minute, oldest_day } = rows[0]!;
      const over = (oldest: Date | null, window: number) => Math.max(1, Math.ceil(((oldest?.getTime() ?? now.getTime()) + window - now.getTime()) / 1000));
      if (Number(day) >= this.limits.perDay) {
        await client.query("ROLLBACK");
        return { allowed: false, retryAfterSeconds: over(oldest_day, 86_400_000) };
      }
      if (Number(minute) >= this.limits.perMinute) {
        await client.query("ROLLBACK");
        return { allowed: false, retryAfterSeconds: over(oldest_minute, 60_000) };
      }
      await client.query("INSERT INTO chat_turns (user_id, at) VALUES ($1, $2)", [userId, now]);
      // Rows older than the day window count for nothing, so they go.
      await client.query("DELETE FROM chat_turns WHERE user_id = $1 AND at <= $2::timestamptz - interval '1 day'", [userId, now]);
      await client.query("COMMIT");
      return { allowed: true };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }
}

// Runs after sign-in, so the user is on response.locals. A refused turn is a 429 with a plain
// message and a Retry-After header: no count, no limit, no reason a caller could tune against.
export function chatLimit(limiter: Pick<ChatLimiter, "take">): RequestHandler {
  return async (_request, response, next) => {
    try {
      const user = response.locals.user as Identity;
      const result = await limiter.take(user.userId);
      if (result.allowed) return next();
      response.setHeader("Retry-After", String(result.retryAfterSeconds));
      response.status(429).json({ error: LIMIT_MESSAGE });
    } catch (error) {
      next(error);
    }
  };
}

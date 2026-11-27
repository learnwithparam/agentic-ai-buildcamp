import "../load-env";

// The day the desk treats as "today": which label is in force, which campaign is open. It is the
// real date (UTC) unless MEDINFO_TODAY names another day. Tests and the dataset runner name one, so
// a case's expected answer does not change when a label's effective date passes.
export const PINNED_DAY = "2026-11-23";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export function resolveToday(vars: Record<string, string | undefined> = process.env, now: Date = new Date()): string {
  const named = vars.MEDINFO_TODAY?.trim();
  if (!named) return now.toISOString().slice(0, 10);
  const parsed = new Date(`${named}T00:00:00Z`);
  if (!DAY.test(named) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== named) {
    throw new Error(`MEDINFO_TODAY must be a real day written YYYY-MM-DD, not "${named}".`);
  }
  return named;
}

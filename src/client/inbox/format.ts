// One way to write a deadline everywhere on the page: weekday, day, month and time, in the
// reader's own time zone.
const DUE = new Intl.DateTimeFormat(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export const formatDue = (iso: string) => DUE.format(new Date(iso));

// "in 23 hours", or "2 hours late" once it has passed.
export function timeLeft(iso: string, now = Date.now()): string {
  const hours = Math.round((new Date(iso).getTime() - now) / 3_600_000);
  if (hours < 0) return `${-hours} ${-hours === 1 ? "hour" : "hours"} late`;
  if (hours === 0) return "due within the hour";
  return `in ${hours} ${hours === 1 ? "hour" : "hours"}`;
}

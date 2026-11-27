// The dates a sentence gives, as a doctor writes them: "March 1, 2027", "1 March 2027",
// "2027-03-01", or a year alone ("the 2027 label"). Days come back as YYYY-MM-DD, the form the
// label metadata uses; a year that is part of a full date is not listed again as a year.
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH = `(${MONTHS.join("|")}|${MONTHS.map((m) => m.slice(0, 3)).join("|")})\\.?`;
const pad = (n: number | string) => String(n).padStart(2, "0");
const monthOf = (name: string) => pad(MONTHS.findIndex((m) => m.startsWith(name.toLowerCase().slice(0, 3))) + 1);

export function datesIn(text: string): { days: string[]; years: string[] } {
  const days: string[] = [];
  let rest = text;
  const take = (pattern: RegExp, toDay: (m: RegExpMatchArray) => string) => {
    rest = rest.replace(pattern, (...args) => (days.push(toDay(args as unknown as RegExpMatchArray)), " "));
  };
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => `${m[1]}-${m[2]}-${m[3]}`);
  take(new RegExp(`\\b${MONTH}\\s+(\\d{1,2}),?\\s+(\\d{4})\\b`, "gi"), (m) => `${m[3]}-${monthOf(m[1]!)}-${pad(m[2]!)}`);
  take(new RegExp(`\\b(\\d{1,2})\\s+${MONTH}\\s+(\\d{4})\\b`, "gi"), (m) => `${m[3]}-${monthOf(m[2]!)}-${pad(m[1]!)}`);
  const years = [...rest.matchAll(/\b(19|20)\d{2}\b/g)].map(([year]) => year);
  return { days, years };
}

// meet-the-world: the learner ran the naive employee and the reference, and wrote down what the ledger and the
// board showed. The answers come from the world's planted traps, so they are read from traps.json, not typed here.
// `bun run verify meet-the-world --setup` prints the setup table instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { TRAPS } from "../worlds/freight-audit/world";
import { setupTable } from "./lib/setup";

const argv = process.argv.slice(2);
if (argv[0] === "meet-the-world" && argv.includes("--setup")) process.exit(await setupTable());
if (argv[0] === "meet-the-world" && argv.length === 1)
  process.on("exit", (code) => {
    if (code === 0)
      console.log(
        "You ran the reference. Your goal: your own employee passes the same checks. Next: `bun run verify place-it-on-the-map`.",
      );
  });

const notes = (d: string) => join(d, "notes.md");
const answer = (d: string, label: string) => {
  const m = readFileSync(notes(d), "utf8").match(new RegExp(`^${label}:\\s*(.*)$`, "mi"));
  return (m?.[1] ?? "").trim().toUpperCase();
};
const names = (d: string, label: string, id: string) =>
  answer(d, label)
    .split(/[\s,]+/)
    .includes(id);

export default [
  {
    says: "notes.md exists in the problem folder",
    test: (d) => existsSync(notes(d)),
    tryNext: "keep the notes.md that came with the step and fill in each line",
  },
  {
    says: "Paid twice: names the invoice the naive employee paid twice",
    test: (d) => names(d, "Paid twice", TRAPS.pay_times_out_after_write.invoice_id),
    tryNext:
      "run bun run reference naive, then find the row on localhost:7700/ledger marked paid twice",
  },
  {
    says: "Not paid: names the invoice the naive employee said it paid but the ledger shows open",
    test: (d) => names(d, "Not paid", TRAPS.pay_times_out_twice_without_write.invoice_id),
    tryNext:
      "read the naive run's ledger table again: one invoice shows NOT PAID even though it said done",
  },
  {
    says: "Needs you: names the invoice the reference left waiting for Lena",
    test: (d) => names(d, "Needs you", TRAPS.over_ravi_limit.invoice_id),
    tryNext:
      "run bun run reference and open localhost:7702/board; copy the invoice in the Needs you column",
  },
  {
    says: "Refused: names the invoice the reference refused",
    test: (d) => names(d, "Refused", TRAPS.white_text.invoice_id),
    tryNext: "open localhost:7702/board and copy the invoice in the Refused column",
  },
] satisfies Rule[];

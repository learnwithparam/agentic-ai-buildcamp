// meet-the-world: the learner ran the naive employee and the reference, and wrote down what the
// ledger and the board showed. The answers come from the world's planted traps, so they are read
// from traps.json, not typed here.
// `bun run verify meet-the-world --setup` prints the setup table instead.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { TRAPS } from "../worlds/freight-audit/world";
import { setupTable } from "./lib/setup";

const commandArguments = process.argv.slice(2);
const isThisStep = commandArguments[0] === "meet-the-world";
if (isThisStep && commandArguments.includes("--setup")) process.exit(await setupTable());
if (isThisStep && commandArguments.length === 1) {
  process.on("exit", (exitCode) => {
    if (exitCode !== 0) return;
    console.log("You ran the reference. Your goal: your own employee passes the same checks.");
  });
}

const notesPath = (folder: string) => join(folder, "notes.md");

// The learner's answer on the line "<label>: ...", in upper case so INV-2041 and inv-2041 match.
function answer(folder: string, label: string): string {
  const notes = readFileSync(notesPath(folder), "utf8");
  const line = notes.match(new RegExp(`^${label}:\\s*(.*)$`, "mi"));
  return (line?.[1] ?? "").trim().toUpperCase();
}

function names(folder: string, label: string, invoiceId: string): boolean {
  const answeredIds = answer(folder, label).split(/[\s,]+/);
  return answeredIds.includes(invoiceId);
}

export default [
  {
    says: "notes.md exists in the problem folder",
    test: (folder) => existsSync(notesPath(folder)),
    tryNext: "keep the notes.md that came with the step and fill in each line",
  },
  {
    says: "Paid twice: names the invoice the naive employee paid twice",
    test: (folder) => names(folder, "Paid twice", TRAPS.pay_times_out_after_write.invoice_id),
    tryNext:
      "run bun run reference naive, then find the row on localhost:7700/ledger marked paid twice",
  },
  {
    says: "Not paid: names the invoice the naive employee said it paid but the ledger shows open",
    test: (folder) => names(folder, "Not paid", TRAPS.pay_times_out_twice_without_write.invoice_id),
    tryNext:
      "read the naive run's ledger table again: " +
      "one invoice shows NOT PAID even though it said done",
  },
  {
    says: "Needs you: names the invoice the reference left waiting for Lena",
    test: (folder) => names(folder, "Needs you", TRAPS.over_ravi_limit.invoice_id),
    tryNext:
      "run bun run reference and open localhost:7702/board; " +
      "copy the invoice in the Needs you column",
  },
  {
    says: "Refused: names the invoice the reference refused",
    test: (folder) => names(folder, "Refused", TRAPS.white_text.invoice_id),
    tryNext: "open localhost:7702/board and copy the invoice in the Refused column",
  },
] satisfies Rule[];

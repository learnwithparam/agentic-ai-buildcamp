import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { headerRow, SCOREBOARD_FILE } from "./scoreboard";

// A table written before a slice existed, put under today's header: each cell moves to the column
// with its slice's name, and a slice the row never ran shows "-". The checkpoint sync runs this on
// every tag, because a tag keeps its own scoreboard while the dataset, and so the slices, are shared.
// It imports only headerRow and SCOREBOARD_FILE, which every tag's own scoreboard.ts has, so the
// header is the one that tag's loader and check expect.
export function alignScoreboard(text: string, header = headerRow()): string {
  const lines = text.split("\n");
  const at = lines.findIndex((line) => line.startsWith("| Chapter |"));
  if (at < 0) return text;
  const names = (line: string) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const old = names(lines[at]);
  const now = names(header);
  return lines
    .map((line, i) => {
      if (i === at) return header;
      if (i === at + 1) return `|${" --- |".repeat(now.length)}`;
      if (i < at + 2 || !line.startsWith("|")) return line;
      const cells = names(line);
      return `| ${now.map((name) => (old.includes(name) ? cells[old.indexOf(name)] : "-")).join(" | ")} |`;
    })
    .join("\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = readFileSync(SCOREBOARD_FILE, "utf8");
  const after = alignScoreboard(before);
  if (after !== before) writeFileSync(SCOREBOARD_FILE, after);
}

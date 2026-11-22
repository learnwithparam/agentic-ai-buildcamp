// bun run commands: every command in a page or a comment uses a name, never a number or a file.
// A number breaks when the order changes, as in "goto 03" or "M=01". A name does not.
// A question must read like a person asked it: "dose" fails, "What is the current dose?" passes.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./root";
import { finish } from "./units";

const FOLDERS = ["docs", "apps", "packages", "src", "checks", "content", "tests"];
const FILES = ["README.md", "SUBMIT.md"];
const FEWEST_QUESTION_WORDS = 5;
const BY_NUMBER = /bun run (goto|verify|eval) \d|\bM=\d/;
const QUESTION = /--question "([^"]*)"/g;

export function commandProblems(file: string, text: string): string[] {
  const found: string[] = [];
  text.split("\n").forEach((line, index) => {
    const where = `${file}:${index + 1}`;
    if (BY_NUMBER.test(line)) found.push(`${where}: uses a number (${line.trim()}). Use the name.`);
    for (const match of line.matchAll(QUESTION)) {
      const question = match[1].trim();
      const words = question.split(" ").length;
      const placeholder = question.includes("$") || question === "...";
      if (question !== "" && words < FEWEST_QUESTION_WORDS && !placeholder) {
        found.push(`${where}: short question, ask in 5 words or more: "${question}"`);
      }
    }
  });
  return found;
}

function filesIn(folder: string): string[] {
  const base = join(ROOT, folder);
  if (!existsSync(base)) return [];
  const found: string[] = [];
  for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
    const wanted = entry.name.endsWith(".ts") || entry.name.endsWith(".md");
    if (entry.isFile() && wanted)
      found.push(join(entry.parentPath, entry.name).replace(`${ROOT}/`, ""));
  }
  return found;
}

if (import.meta.main) {
  const all = [...FILES, ...FOLDERS.flatMap(filesIn)];
  const problems = all.flatMap((file) =>
    commandProblems(file, readFileSync(join(ROOT, file), "utf8")),
  );
  finish(problems, "Every run command uses a name.", "bad run commands.");
}

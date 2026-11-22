// Reads the English inside code: comments, and the text fields a learner sees on screen.
// It uses the same grade 6 rules as the pages (scripts/plain-english.ts).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { problemsIn, readingGrade, sentencesOf } from "./plain-english";
import { ROOT } from "./root";
import { finish } from "./units";

// The code a learner reads. Tooling in scripts/ is for maintainers and is not graded here.
const FOLDERS = ["apps", "packages", "src", "checks", "content", "config"];
const FIELDS = ["about", "terms", "challenge", "promise", "production", "why", "title", "meaning"];
const BLOCK_GRADE = 6.5;
const EMPTY_PHRASES = [
  "whole idea",
  "top to bottom",
  "skim",
  "skip",
  "helpers",
  "core logic",
  "read the function",
];

function isCommand(line: string): boolean {
  const text = line.replace("//", "").trim();
  return text.startsWith("bun ") || text.startsWith("Run it");
}

function isRegionMarker(line: string): boolean {
  return /^\/\/\s*#(region|endregion|stub)/.test(line.trim());
}

function isProse(line: string): boolean {
  const trimmed = line.trim();
  const isStub = trimmed.startsWith("//~");
  return trimmed.startsWith("//") && !isStub && !isCommand(trimmed) && !isRegionMarker(trimmed);
}

// Comment lines become paragraphs. A blank comment line ends a paragraph.
export function commentText(code: string): string {
  const paragraphs: string[] = [""];
  for (const line of code.split("\n")) {
    if (!isProse(line)) {
      if (paragraphs[paragraphs.length - 1] !== "") paragraphs.push("");
      continue;
    }
    const text = line.trim().replace("//", "").trim();
    if (text === "") paragraphs.push("");
    else paragraphs[paragraphs.length - 1] += `${text} `;
  }
  return paragraphs.join("\n\n");
}

// Text fields such as about: "..." that a learner reads on screen.
export function fieldText(code: string): string {
  const found: string[] = [];
  const joined = code.replace(/(\w+):\s*\n\s*"/g, '$1: "');
  for (const line of joined.split("\n")) {
    for (const name of FIELDS) {
      const start = line.indexOf(`${name}: "`);
      if (start < 0) continue;
      const rest = line.slice(start + name.length + 3);
      found.push(rest.slice(0, rest.indexOf('",')));
    }
  }
  return found.join("\n\n");
}

// Shouting and empty talk say nothing. A comment says what the next lines do.
export function styleProblems(code: string): string[] {
  const found: string[] = [];
  for (const line of code.split("\n").filter(isProse)) {
    const text = line.trim().replace("//", "").trim();
    const letters = text.replace(/[^A-Za-z]/g, "");
    if (letters.length > 8 && letters === letters.toUpperCase()) {
      found.push(`shouting comment "${text}": write a plain sentence`);
    }
    for (const phrase of EMPTY_PHRASES) {
      if (text.toLowerCase().includes(phrase)) found.push(`empty phrase "${phrase}" in "${text}"`);
    }
  }
  return found;
}

// Every block is graded alone, so one hard block cannot hide inside an easy file.
// A heading has no full stop, so it is a title, not a sentence. Titles are not graded.
export function blockProblems(text: string): string[] {
  const found: string[] = [];
  for (const block of text.split("\n\n")) {
    const sentences = sentencesOf(block);
    if (sentences.length === 0 || !/[.!?:]/.test(block)) continue;
    const grade = readingGrade(sentences);
    if (grade <= BLOCK_GRADE) continue;
    const start = block.trim().slice(0, 50);
    found.push(`grade ${grade.toFixed(1)} block "${start}..."`);
  }
  return found;
}

export function codeProblems(file: string, code: string): string[] {
  const found = [...styleProblems(code), ...blockProblems(commentText(code))];
  const text = `${commentText(code)}\n\n${fieldText(code)}`;
  for (const problem of problemsIn(file, text, 6)) found.push(problem.message);
  return found.map((message) => `${file}: ${message}`);
}

function codeFiles(): string[] {
  const files: string[] = [];
  for (const folder of FOLDERS) {
    const base = join(ROOT, folder);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true, recursive: true })) {
      if (entry.isFile() && entry.name.endsWith(".ts"))
        files.push(join(entry.parentPath, entry.name));
    }
  }
  return files.filter((file) => !file.includes("node_modules"));
}

if (import.meta.main) {
  const problems = codeFiles().flatMap((file) => {
    return codeProblems(relative(ROOT, file), readFileSync(file, "utf8"));
  });
  finish(
    problems,
    "Every code comment and screen text reads at grade 6 or below.",
    "code-English problems.",
  );
}

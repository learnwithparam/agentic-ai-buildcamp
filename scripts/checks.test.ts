// Each course check must bite: feed it a planted violation and it must report it.
import { describe, expect, test } from "bun:test";
import type { UnitContent } from "../src/content";
import { UNITS } from "../src/workshop";
import { opaqueIds, unitProblems } from "./distinct";
import { glossaryProblems, lessonOf, meaningProblems } from "./glossary";
import { mermaidBlocks } from "./mermaid";
import { stuckProblems } from "./stuck";
import type { Loaded } from "./units";

const GOOD: UnitContent = {
  opening: "Why does the agent quote an old dose?",
  production: "The medical team trusts one current label.",
  terms: [
    { id: "label", word: "label", meaning: "The paper that says how a drug is used." },
    { id: "trace", word: "trace", meaning: "A record of every step the agent took." },
  ],
  picture: "flowchart LR\n  question --> answer",
  stuck: {
    correct: "The answer names the current label.",
    wrong: "The old label comes back first.",
    hint: "Look at which label is active.",
    rows: [
      ["old label returned", "The swap did not run.", "Run the swap in one step."],
      ["no label found", "The file did not load.", "Run the seed again."],
    ],
  },
  breaks: [],
};

function loaded(slug: string, content: UnitContent, page: string): Loaded {
  return { unit: { ...UNITS[0], slug }, content, page };
}

const PAGE = "The label tells the team the dose. Each trace shows a step.";

describe("glossary", () => {
  test("a clean unit has no problems", () => {
    expect(glossaryProblems([loaded("one", GOOD, PAGE)])).toEqual([]);
  });
  test("a word defined twice is caught", () => {
    const problems = glossaryProblems([loaded("one", GOOD, PAGE), loaded("two", GOOD, PAGE)]);
    expect(problems.some((problem) => problem.startsWith("G3"))).toBe(true);
  });
  test("a long meaning is caught", () => {
    const long = "This is a meaning that goes on and on and on and on and on and on and on.";
    expect(meaningProblems("x", long).length).toBeGreaterThan(0);
  });
  test("a word missing from the lesson is caught", () => {
    const problems = glossaryProblems([loaded("one", GOOD, "Nothing here.")]);
    expect(problems.some((problem) => problem.startsWith("G6"))).toBe(true);
  });
  test("the word list does not count as use", () => {
    const page = "## New words\nlabel trace\n\n## Next\nNothing.";
    expect(lessonOf(page).includes("label")).toBe(false);
  });
});

describe("stuck", () => {
  test("a message no check prints is caught", () => {
    const problems = stuckProblems(loaded("one", GOOD, PAGE), "nothing printed");
    expect(problems.some((problem) => problem.startsWith("S4"))).toBe(true);
  });
  test("real messages pass", () => {
    const source = 'say("old label returned"); say("no label found");';
    expect(stuckProblems(loaded("one", GOOD, PAGE), source)).toEqual([]);
  });
  test("one row is too few", () => {
    const thin = { ...GOOD, stuck: { ...GOOD.stuck, rows: [GOOD.stuck.rows[0]] } };
    const problems = stuckProblems(loaded("one", thin, PAGE), "old label returned");
    expect(problems.some((problem) => problem.startsWith("S3"))).toBe(true);
  });
});

describe("distinct", () => {
  test("two units with one opening are caught", () => {
    const problems = unitProblems([loaded("one", GOOD, PAGE), loaded("two", GOOD, PAGE)]);
    expect(problems.some((problem) => problem.startsWith("D1"))).toBe(true);
  });
  test("an empty production line is caught", () => {
    const problems = unitProblems([loaded("one", { ...GOOD, production: " " }, PAGE)]);
    expect(problems.some((problem) => problem.startsWith("D3"))).toBe(true);
  });
  test("opaque ids are caught but standards are not", () => {
    expect(opaqueIds("see DOC-101 and H-1")).toEqual(["DOC-101", "H-1"]);
    expect(opaqueIds("uses SHA-256 and UTF-8")).toEqual([]);
  });
});

describe("mermaid", () => {
  test("finds each block", () => {
    const block = (text: string) => `\`\`\`mermaid\n${text}\n\`\`\`\n`;
    const first = block("flowchart LR\n  a --> b");
    const second = block("flowchart TD\n  c --> d");
    const page = `text\n${first}more\n${second}`;
    expect(mermaidBlocks(page).length).toBe(2);
  });
});

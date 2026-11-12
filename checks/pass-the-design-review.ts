import type { Rule } from "../scripts/verify";
import { hasFile, readText } from "./design-lib";

const QUESTIONS = [
  "outcome checkable",
  "must-never checkable",
  "approver named",
  "cost below value",
  "tenant safe",
  "stop rule",
];
type Reviewer = { name: string; body: string };

// Each "## Reviewer: Name" heading starts one reviewer; their answers run to the next heading.
function reviewers(folder: string): Reviewer[] {
  const chunks = readText(folder, "review.md")
    .split(/^## Reviewer:/m)
    .slice(1);
  return chunks.map((chunk) => {
    const lineEnd = chunk.indexOf("\n");
    if (lineEnd < 0) return { name: chunk.trim(), body: "" };
    const body = chunk.slice(lineEnd + 1).split(/^## /m)[0];
    return { name: chunk.slice(0, lineEnd).trim(), body };
  });
}

function answer(reviewer: Reviewer, question: string): string {
  const line = reviewer.body.match(new RegExp(`^- ${question}:\\s*(.*)$`, "im"));
  return line?.[1]?.trim() ?? "";
}

// A real name is capitalised words, not a placeholder left from the template.
const isRealName = (name: string) =>
  /^\p{Lu}[\p{L}'.-]+( \p{Lu}[\p{L}'.-]+)*$/u.test(name) &&
  !/^(name|reviewer|todo|you)$/i.test(name);

const hasTwoReviewers = (folder: string) => reviewers(folder).length >= 2;

// True when every reviewer's answer to every question passes the test.
function everyAnswer(folder: string, passes: (answerText: string) => boolean): boolean {
  return reviewers(folder).every((reviewer) =>
    QUESTIONS.every((question) => passes(answer(reviewer, question))),
  );
}

const isReasonedYesOrNo = (answerText: string) =>
  /^(yes|no)\b[.,:]?\s+\S+(\s+\S+){3,}/i.test(answerText);

export default [
  {
    says: "review.md exists",
    test: (folder) => hasFile(folder, "review.md"),
    tryNext: "create review.md in this folder",
  },
  {
    says: "two named peer reviewers",
    test: (folder) => {
      const all = reviewers(folder);
      const uniqueNames = new Set(all.map((reviewer) => reviewer.name));
      return (
        all.length >= 2 &&
        all.every((reviewer) => isRealName(reviewer.name)) &&
        uniqueNames.size === all.length
      );
    },
    tryNext: "add two headings like ## Reviewer: Priya Nair, one per person, with their real names",
  },
  {
    says: "each reviewer answers all six questions",
    test: (folder) =>
      hasTwoReviewers(folder) && everyAnswer(folder, (answerText) => answerText.length > 0),
    tryNext:
      "under each reviewer add six lines that start - outcome checkable:, " +
      "- must-never checkable:, and so on",
  },
  {
    says: "each answer is yes or no with one line of reason",
    test: (folder) => hasTwoReviewers(folder) && everyAnswer(folder, isReasonedYesOrNo),
    tryNext: "start each answer with yes or no, then one line of at least four words that says why",
  },
  {
    says: "every answer is yes",
    test: (folder) =>
      hasTwoReviewers(folder) && everyAnswer(folder, (answerText) => /^yes\b/i.test(answerText)),
    tryNext: "fix the design for each no, then ask that reviewer the question again",
  },
] satisfies Rule[];

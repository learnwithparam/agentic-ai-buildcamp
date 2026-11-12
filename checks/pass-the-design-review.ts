import type { Rule } from "../scripts/verify";
import { has, text } from "./design-lib";

const QUESTIONS = [
  "outcome checkable",
  "must-never checkable",
  "approver named",
  "cost below value",
  "tenant safe",
  "stop rule",
];
type Reviewer = { name: string; body: string };
const reviewers = (d: string): Reviewer[] =>
  text(d, "review.md")
    .split(/^## Reviewer:/m)
    .slice(1)
    .map((c) => {
      const nl = c.indexOf("\n");
      return {
        name: c.slice(0, nl < 0 ? undefined : nl).trim(),
        body: nl < 0 ? "" : c.slice(nl + 1).split(/^## /m)[0],
      };
    });
const answer = (r: Reviewer, q: string) =>
  r.body.match(new RegExp(`^- ${q}:\\s*(.*)$`, "im"))?.[1]?.trim() ?? "";
const realName = (n: string) =>
  /^\p{Lu}[\p{L}'.-]+( \p{Lu}[\p{L}'.-]+)*$/u.test(n) && !/^(name|reviewer|todo|you)$/i.test(n);
const two = (d: string) => reviewers(d).length >= 2;

export default [
  {
    says: "review.md exists",
    test: (d) => has(d, "review.md"),
    tryNext: "create review.md in this folder",
  },
  {
    says: "two named peer reviewers",
    test: (d) => {
      const r = reviewers(d);
      return (
        r.length >= 2 &&
        r.every((x) => realName(x.name)) &&
        new Set(r.map((x) => x.name)).size === r.length
      );
    },
    tryNext: "add two headings like ## Reviewer: Priya Nair, one per person, with their real names",
  },
  {
    says: "each reviewer answers all six questions",
    test: (d) =>
      two(d) && reviewers(d).every((r) => QUESTIONS.every((q) => answer(r, q).length > 0)),
    tryNext:
      "under each reviewer add six lines that start - outcome checkable:, - must-never checkable:, and so on",
  },
  {
    says: "each answer is yes or no with one line of reason",
    test: (d) =>
      two(d) &&
      reviewers(d).every((r) =>
        QUESTIONS.every((q) => /^(yes|no)\b[.,:]?\s+\S+(\s+\S+){3,}/i.test(answer(r, q))),
      ),
    tryNext: "start each answer with yes or no, then one line of at least four words that says why",
  },
  {
    says: "every answer is yes",
    test: (d) =>
      two(d) && reviewers(d).every((r) => QUESTIONS.every((q) => /^yes\b/i.test(answer(r, q)))),
    tryNext: "fix the design for each no, then ask that reviewer the question again",
  },
] satisfies Rule[];

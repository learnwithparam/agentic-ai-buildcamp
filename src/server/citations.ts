import type { ChatMessage } from "../shared/messages";

// Lesson 21. The answer is checked against the sections search_labels returned, in code, before it
// is final. The desk rules already say "answer only from active label text" and "cite every fact";
// a rule in a prompt is a request, and stored answers show the model breaking it: asked whether
// CardioNex was approved at 50mg twice daily, it cited the expired 2024 draft in 6 of 9 answers.

// The fields of a search_labels result this check reads (src/server/tools.ts, labelSearch).
export type RetrievedSection = { doc_id: string; section: string; status: string; text: string };

export type CitationProblem =
  | { kind: "not_retrieved"; citation: string }
  | { kind: "not_in_force"; citation: string; status: string }
  | { kind: "uncited"; quantity: string; sentence: string }
  | { kind: "unsupported"; quantity: string; citations: string[]; sentence: string };

const BRACKET = /\[([^\]]+)\]/g;
const CITATION = /^\s*([a-z0-9][a-z0-9-]*)\s*,\s*(\d+(?:\.\d+)?)/;

// "[cardionex-uspi-v2, 2.2]" and "[cardionex-uspi-v2, 0.0; cardionex-de-smpc, 4.3]" both count.
export function parseCitations(text: string): string[] {
  const found: string[] = [];
  for (const [, inside] of text.matchAll(BRACKET)) {
    for (const part of inside.split(";")) {
      const match = part.match(CITATION);
      if (match) found.push(`${match[1]}, ${match[2]}`);
    }
  }
  return found;
}

// A number a doctor acts on: a dose, a wait, a lab value or a rate. "20-40mg" gives both numbers
// the unit, so "20 mg to 40 mg" in an answer matches it.
const UNIT = String.raw`(mg|mcg|hours?|hrs?|days?|weeks?|months?|years?|%|meq/l|ml/min)`;
const RANGE = new RegExp(String.raw`(\d+(?:\.\d+)?)\s*(?:-|–|to)\s*(\d+(?:\.\d+)?)[\s-]*${UNIT}\b`, "gi");
const QUANTITY = new RegExp(String.raw`(\d+(?:\.\d+)?)[\s-]*${UNIT}(?![a-z])`, "gi");
const SAME_UNIT: Record<string, string> = { hr: "hour", hrs: "hour", hours: "hour", days: "day", weeks: "week", months: "month", years: "year" };

const quantity = (value: string, unit: string) => {
  const lower = unit.toLowerCase();
  return `${Number(value)} ${SAME_UNIT[lower] ?? lower}`;
};

export function quantities(text: string): Set<string> {
  const plain = text.replace(/\*/g, "");
  const found = new Set<string>();
  for (const [, from, to, unit] of plain.matchAll(RANGE)) found.add(quantity(from, unit)).add(quantity(to, unit));
  for (const [, value, unit] of plain.matchAll(QUANTITY)) found.add(quantity(value, unit));
  return found;
}

const numbersIn = (text: string) => new Set([...text.matchAll(/\d+(?:\.\d+)?/g)].map(([value]) => Number(value)));
// A citation written after the full stop ("... once daily. [doc, 2.2]") belongs to that sentence,
// not to the next one, so it is moved inside before the paragraph is cut into sentences.
const sentencesOf = (paragraph: string) =>
  paragraph
    .replace(/([.!?])((?:\s*\[[^\]]+\])+)/g, "$2$1")
    .split(/\n|(?<=[.!?])\s+/)
    .filter((line) => line.trim());

// Every citation must name a section this turn's search returned and that is in force today. Every
// quantity must be in the text of the sections its sentence cites (or, when the sentence cites
// none, its paragraph, then the whole answer). A number the doctor gave (eGFR 24) is a fact about
// the patient, not a claim from the label, so it is left alone. An answer with no number and no
// citation, such as a follow-up question or a refusal, has nothing to check.
export function checkCitations(answer: string, retrieved: RetrievedSection[], asked: string): CitationProblem[] {
  const sections = new Map(retrieved.map((section) => [`${section.doc_id}, ${section.section}`, section]));
  const given = numbersIn(asked);
  const problems: CitationProblem[] = [];
  const all = parseCitations(answer);
  for (const citation of new Set(all)) {
    const section = sections.get(citation);
    if (!section) problems.push({ kind: "not_retrieved", citation });
    else if (section.status !== "active") problems.push({ kind: "not_in_force", citation, status: section.status });
  }
  for (const paragraph of answer.split(/\n\s*\n/)) {
    const inParagraph = parseCitations(paragraph);
    for (const sentence of sentencesOf(paragraph)) {
      const own = parseCitations(sentence);
      const cited = own.length ? own : inParagraph.length ? inParagraph : all;
      const support = new Set(cited.flatMap((citation) => [...quantities(sections.get(citation)?.text ?? "")]));
      for (const found of quantities(sentence)) {
        if (given.has(Number(found.split(" ")[0])) || support.has(found)) continue;
        const text = sentence.trim();
        problems.push(cited.length ? { kind: "unsupported", quantity: found, citations: cited, sentence: text } : { kind: "uncited", quantity: found, sentence: text });
      }
    }
  }
  return problems;
}

// What the model is told when its answer fails, so the one rewrite knows what to fix.
export function describeProblem(problem: CitationProblem): string {
  switch (problem.kind) {
    case "not_retrieved":
      return `[${problem.citation}] is not a section search_labels returned in this conversation. Cite only sections it returned.`;
    case "not_in_force":
      return `[${problem.citation}] is ${problem.status}, not in force today. Do not cite it or state its doses; answer from active sections only.`;
    case "uncited":
      return `"${problem.quantity}" has no citation: "${problem.sentence}". Cite the section that states it.`;
    case "unsupported":
      return `"${problem.quantity}" is not in ${problem.citations.map((citation) => `[${citation}]`).join(" ")}: "${problem.sentence}". Cite the section that states it, or leave the number out.`;
  }
}

// The sections search_labels returned in this conversation, and every question the doctor asked
// in it. A follow-up ("and if she is on dialysis?") is often answered from the sections the first
// question found, with no new search; they were found under the same permissions, on the same day.
// When a section comes back twice, the later result wins.
// Every tool whose output holds label sections the answer may cite. search_labels returns
// results, the lookups return sections or uses, and read_section returns one section itself.
export const EVIDENCE_TOOLS = ["search_labels", "read_section", "approval_status", "check_interaction", "trial_results"];

type ToolOutput = RetrievedSection & { results?: RetrievedSection[]; sections?: RetrievedSection[]; uses?: RetrievedSection[] };

function sectionsIn(output: ToolOutput): RetrievedSection[] {
  const listed = [...(output.results ?? []), ...(output.sections ?? []), ...(output.uses ?? [])];
  return output.doc_id && output.section && output.text ? [...listed, output] : listed;
}

export function evidenceOf(messages: ChatMessage[]): { retrieved: RetrievedSection[]; asked: string } {
  const sections = new Map<string, RetrievedSection>();
  for (const message of messages) {
    if (message.type !== "tool" || !EVIDENCE_TOOLS.includes(message.name ?? "")) continue;
    try {
      for (const section of sectionsIn(JSON.parse(message.content))) {
        sections.set(`${section.doc_id}, ${section.section}`, section);
      }
    } catch {
      // A failed search has no results to cite.
    }
  }
  const asked = messages.flatMap((message) => (message.type === "human" ? [message.content] : [])).join("\n");
  return { retrieved: [...sections.values()], asked };
}

// The reply when the rewrite fails the check too. A doctor gets no answer rather than an unchecked one.
export const WITHHELD_REPLY =
  "I could not tie every fact in my answer to a label section that is in force today, so I am not sending it. Please ask the medical information team.";

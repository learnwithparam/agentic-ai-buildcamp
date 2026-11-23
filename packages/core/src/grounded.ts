// The grounded agent answers only from the active documents. The model's reply is a claim.
// This code checks the claim: it must cite a document it was shown, and use only its numbers.

import { BRANDS, COUNTRIES } from "../../../data/catalog/brands";
import type { AgentResult } from "../../../src/grade";
import { ask } from "./ask";
import { scrubDocument } from "./guardrails";
import { activeDocuments, type StoredDocument } from "./ingestion";
import { type Tags, traced } from "./telemetry";

export type Generate = (prompt: string) => Promise<string>;

const NOT_THERE = "NOT_IN_DOCUMENTS";
const HOME_COUNTRY = "US";

type Subject = { brand: string; country: string };

function subjectOf(question: string): Subject | undefined {
  const text = question.toLowerCase();
  const brand = BRANDS.find((item) => text.includes(item.name.toLowerCase()));
  if (brand === undefined) return undefined;
  const country = COUNTRIES.find((item) => question.includes(item.name) || isDemonym(text, item));
  return { brand: brand.name, country: country === undefined ? HOME_COUNTRY : country.code };
}

const NATIONALITIES: [code: string, word: string][] = [
  ["DE", "german"],
  ["BR", "brazil"],
  ["JP", "japan"],
  ["US", "american"],
];

function isDemonym(text: string, country: { code: string }): boolean {
  return NATIONALITIES.some(([code, word]) => code === country.code && text.includes(word));
}

function refusal(text: string): AgentResult {
  return { route: "refuse", text, citations: [] };
}

// #region step:grounded-answer
export function groundedPrompt(question: string, documents: StoredDocument[]): string {
  const shown = documents.map((item) => `[${item.slug}]\n${scrubDocument(item.body)}`).join("\n\n");
  const rules = `Answer from the documents only. End with the id of each document you used.
Write each id in square brackets. If the documents do not say, reply ${NOT_THERE}.`;
  return [rules, shown, `Question: ${question}`].join("\n\n");
}

export function checkClaim(text: string, documents: StoredDocument[]): string | undefined {
  const cited = [...text.matchAll(/\[([a-z0-9-]+)\]/g)].map((match) => match[1]);
  if (cited.length === 0) return "the answer cites no document";
  const shown = documents.map((item) => item.slug);
  if (!cited.every((slug) => shown.includes(slug))) return "the answer cites a document not shown";
  const source = documents.filter((item) => cited.includes(item.slug)).map((item) => item.body);
  const numbers = text.replace(/\[[a-z0-9-]+\]/g, "").match(/\d+(\.\d+)?/g) ?? [];
  const missing = numbers.find((number) => !source.join(" ").includes(number));
  return missing === undefined ? undefined : `the number ${missing} is not in the cited document`;
}

export async function answerGrounded(
  question: string,
  tags: Tags,
  generate: Generate,
): Promise<AgentResult> {
  const subject = subjectOf(question);
  const documents = await findDocuments(subject, tags);
  if (documents.length === 0) return refusal("No current document covers that question.");
  const reply = (await generate(groundedPrompt(question, documents))).trim();
  if (reply === NOT_THERE) return refusal("The documents do not say.");
  const problem = checkClaim(reply, documents);
  if (problem !== undefined) return refusal(`I cannot give that answer: ${problem}.`);
  const citations = [...reply.matchAll(/\[([a-z0-9-]+)\]/g)].map((match) => match[1]);
  return { route: "answer", text: reply, citations };
}
// #stub
//~ // TODO(grounded-answer): show only active documents, then check the model's claim
//~ export function groundedPrompt(question: string, _documents: StoredDocument[]): string {
//~   return question;
//~ }
//~
//~ export function checkClaim(_text: string, _documents: StoredDocument[]): string | undefined {
//~   return undefined;
//~ }
//~
//~ export async function answerGrounded(
//~   question: string,
//~   tags: Tags,
//~   generate: Generate,
//~ ): Promise<AgentResult> {
//~   return { route: "answer", text: await generate(question), citations: [] };
//~ }
// #endregion

async function findDocuments(subject: Subject | undefined, tags: Tags): Promise<StoredDocument[]> {
  if (subject === undefined) return [];
  return traced("retrieval", tags, async (setAttributes) => {
    const found = await activeDocuments(subject.brand, subject.country, tags.person);
    setAttributes({ documents: found.length, brand: subject.brand, country: subject.country });
    return found;
  });
}

// The real agent: the same guard, with a live model call as the generator.
export async function groundedAgent(question: string): Promise<AgentResult> {
  const tags = { tenantId: "pharma-a", agentName: "grounded-answer" };
  const generate: Generate = async (prompt) => (await ask("smart", prompt, tags)).text;
  return answerGrounded(question, tags, generate);
}

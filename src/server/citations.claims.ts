import { observeOpenAI } from "@langfuse/openai";
import type OpenAI from "openai";
import { shortStage } from "./gateway";
import { timed } from "./ops/meter";
import { inForceDocuments, LABEL_SECTIONS } from "./labels";
import type { CitationProblem, ClaimReason, RetrievedSection } from "./citations";

// Lesson 21, claim by claim. The number check in citations.ts leaves a claim with no number
// unchecked. Here every claim of the answer carries a quote, and code checks the quote against the
// label text in data/hcp. Whether the quote says what the claim says is a judgment, so one model
// call (the support judge) makes it, only for a claim whose quote already passed the code checks.

export type Claim = { text: string; quote: string; docId: string; section: string };
export type Verdict = "supported" | "unsupported";
// The support judge: does the quote support the claim? The real one is judgeWithModel; a test
// passes a plain function.
export type Judge = (claim: Claim) => Promise<Verdict>;

export type ClaimContext = {
  // The sections search_labels returned this turn. null skips that one rule (the measure over
  // data/hcp/gold/claims.jsonl has no search to ask).
  retrieved: RetrievedSection[] | null;
  today: string;
  // Numbers the doctor gave: facts about the patient, not claims from the label.
  given?: ReadonlySet<number>;
  // When set, the cited document must be for this country.
  country?: string;
};

// Whitespace and case only. Not Markdown marks, not punctuation: a quote with a mark the label
// does not have is not a quote of it.
export const fold = (text: string) => text.toLowerCase().replace(/\s+/g, " ").trim();

// A digit inside a name (CYP3A4) is part of the name, not a number a doctor acts on.
const numbersIn = (text: string) => [...text.matchAll(/(?<![A-Za-z0-9.])\d+(?:\.\d+)?/g)].map(([value]) => Number(value));

export const sectionText = (docId: string, section: string) => LABEL_SECTIONS.find((s) => s.docId === docId && s.section === section);

// A quote may join sentences that are apart in the section, with an ellipsis between them, as a
// reviewer writes an elision. Each part must be in the section word for word.
export const ELISION = " … ";

export function quoteIsVerbatim(claim: Pick<Claim, "quote" | "docId" | "section">): boolean {
  const found = sectionText(claim.docId, claim.section);
  const parts = claim.quote.split(ELISION).map(fold);
  return !!found && parts.every((part) => part !== "" && fold(found.text).includes(part));
}

// The sentences of a section, cut by code. The claim listing points at them by number and code
// copies them, so a quote cannot be misremembered. Measured on 26 Nov 2026: of 195 answers
// checked, 37 claims failed because the model's copy of the label was not word for word, and each
// sent a true answer to a rewrite. Each line is cut on its own first: a table row, a list item or a
// paragraph has no full stop to end it, and read as one sentence, the dose table of
// cardionex-uspi-v2 2.2 and its footnote were a single 892-character "sentence" the listing could
// only point at whole or not at all (27 Nov 2026: 2 to 5 of 21 gold answers stopped). Within a
// line, a sentence ends at . ! or ? before a space and a capital or a bracket, so 2.5 mg and e.g.
// stay inside one.
export function sentencesOf(text: string): string[] {
  return text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=[A-Z([])/))
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

// The quote a claim's sentence numbers stand for: neighbours joined by a space, a gap by ELISION.
// A number that is not a sentence of the section is dropped; no number left means no quote.
export function quoteFrom(sentences: string[], numbers: number[]): string {
  const picked = [...new Set(numbers)].filter((n) => Number.isInteger(n) && n >= 1 && n <= sentences.length).sort((a, b) => a - b);
  return picked.map((n, i) => (i === 0 ? "" : n === picked[i - 1]! + 1 ? " " : ELISION) + sentences[n - 1]).join("");
}

// The code checks, in the order a doctor would ask: is there such a section, did a search return
// it, is its document in force, is it for this country, is the quote in it, are the claim's
// numbers in the quote. Returns the first reason it fails, or null.
export function checkClaim(claim: Claim, context: ClaimContext): ClaimReason | null {
  const found = sectionText(claim.docId, claim.section);
  if (!found) return "unknown_section";
  if (context.retrieved && !context.retrieved.some((r) => r.doc_id === claim.docId && r.section === claim.section)) return "not_retrieved";
  if (!inForceDocuments(new Set([claim.docId]), context.today).has(claim.docId)) return "not_in_force";
  if (context.country && found.country !== context.country) return "wrong_country";
  if (!quoteIsVerbatim(claim)) return "quote_not_in_section";
  const inQuote = new Set(numbersIn(claim.quote));
  if (numbersIn(claim.text).some((n) => !inQuote.has(n) && !context.given?.has(n))) return "number_not_in_quote";
  return null;
}

// Every claim, checked. A claim that passes the code checks goes to the judge.
export async function reviewClaims(claims: Claim[], context: ClaimContext, judge: Judge): Promise<CitationProblem[]> {
  const results = await Promise.all(
    claims.map(async (claim): Promise<CitationProblem | null> => {
      const citation = `${claim.docId}, ${claim.section}`;
      const reason = checkClaim(claim, context);
      if (reason) return { kind: "claim", reason, citation, claim: claim.text };
      return (await judge(claim)) === "supported" ? null : { kind: "claim", reason: "quote_does_not_support", citation, claim: claim.text };
    })
  );
  return results.filter((problem): problem is CitationProblem => problem !== null);
}

// --- The two model calls. Both go through the gateway client the caller passes (modelClient()).

// The judge reads the quote inside its section, as a reviewer checks a citation. Measured on
// 2026-11-26 with the quote alone: 27 of 45 supported claims were judged unsupported, because a
// quote such as "raised to 40mg after 4 weeks" does not name the trial, the medicine or the
// country its document is about.
export const JUDGE_PROMPT = `You judge whether a quote from a medicine document supports a claim.
You get the claim, the quote, and the section the quote comes from, with its document. The document and the section say what the quote is about: which medicine, trial, country or patient group.
Answer "supported" only when the quote, read in that section, states what the claim says: the same fact, for the same subject, in the same direction.
Answer "unsupported" when the quote is about something else, says the opposite, says less than the claim (the claim adds a condition, a dose, a group or a result the quote lacks), or only shares words with it.
Do not use anything you know about the medicine. Judge the quote and the claim only.`;

// What the judge reads around the quote: the document, its country, the section title and text.
export function sourceOf(claim: Pick<Claim, "docId" | "section">): string {
  const found = sectionText(claim.docId, claim.section);
  return found ? `Section it comes from: ${found.docId} (${found.country}) ${found.section} ${found.title}\n${found.text}` : `Section it comes from: ${claim.docId} ${claim.section}, not found.`;
}

export function judgeWithModel(client: OpenAI): Judge {
  const openai = observeOpenAI(client, { generationName: "claim-support-judge" });
  return async (claim) => {
    const completion = await openai.chat.completions.create({
      temperature: 0,
      ...shortStage("judge"),
      messages: [
        { role: "system", content: JUDGE_PROMPT },
        { role: "user", content: `Claim: ${claim.text}\n\nQuote: ${claim.quote}\n\n${sourceOf(claim)}` }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "support",
          strict: true,
          schema: {
            type: "object",
            properties: { verdict: { type: "string", enum: ["supported", "unsupported"] } },
            required: ["verdict"],
            additionalProperties: false
          }
        }
      }
    });
    const { verdict } = JSON.parse(completion.choices[0]?.message.content ?? "{}") as { verdict?: string };
    // An answer that is not one of the two labels is not a pass.
    return verdict === "supported" ? "supported" : "unsupported";
  };
}

export const CLAIMS_PROMPT = `You list the claims in a doctor's answer, each with the label sentences that state it.
A claim is one fact the answer states about the medicine, from the label. Do not list advice to ask someone, refusals, facts the doctor gave in the question, or which label version is in force and when one takes effect (code checks those from the document dates).
Do not list what the answer says about its own citations (that a figure is also in another section, that either citation is right): the citations are checked by code.
When the answer compares a number the doctor gave with a limit in the label, the claim is the limit as the label states it (for "5.3 is above the 5.0 limit", the claim is the 5.0 limit).
Each section below has its sentences numbered. A table row, a list item and a footnote are sentences too. For each claim give: text (the claim, as the answer says it), docId and section of one section below, and sentences (the numbers of that section's sentences that state the claim, as few as state it fully).
If no section states a claim, still list it, with the closest section and no sentence numbers.`;

// Which version is in force is not label text, so it is not a claim: citeStep's number check
// already refuses a citation of a document that is not in force (citations.ts, statusFor). Listed
// as a claim, each such sentence had no quote and sent a correct answer to a rewrite (26 Nov 2026).

// The answer's claims, read by one json_schema call. The agent's answer is streamed to the doctor
// as text, so its claims are listed after it is written, from the answer and the sections found.
// The model names sentence numbers; code turns them into the quote (quoteFrom).
export async function extractClaims(client: OpenAI, answer: string, retrieved: RetrievedSection[]): Promise<Claim[]> {
  // Nothing found, or nothing written: there is no claim to list, so no model is asked.
  if (!retrieved.length || !answer.trim()) return [];
  const openai = observeOpenAI(client, { generationName: "answer-claims" });
  const numbered = new Map(retrieved.map((s) => [`${s.doc_id}|${s.section}`, sentencesOf(s.text)]));
  const sections = retrieved
    .map((s) => `[${s.doc_id}, ${s.section}]\n${numbered.get(`${s.doc_id}|${s.section}`)!.map((sentence, i) => `(${i + 1}) ${sentence}`).join("\n")}`)
    .join("\n\n");
  const completion = await timed("claim_extract", () => openai.chat.completions.create({
    temperature: 0,
    ...shortStage("claims"),
    messages: [
      { role: "system", content: CLAIMS_PROMPT },
      { role: "user", content: `Answer:\n${answer}\n\nSections:\n\n${sections}` }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "claims",
        strict: true,
        schema: {
          type: "object",
          properties: {
            claims: {
              type: "array",
              items: {
                type: "object",
                properties: { text: { type: "string" }, docId: { type: "string" }, section: { type: "string" }, sentences: { type: "array", items: { type: "integer" } } },
                required: ["text", "docId", "section", "sentences"],
                additionalProperties: false
              }
            }
          },
          required: ["claims"],
          additionalProperties: false
        }
      }
    }
  }));
  const parsed = JSON.parse(completion.choices[0]?.message.content ?? "{}") as { claims?: Array<Omit<Claim, "quote"> & { sentences: number[] }> };
  // A section the search did not return has no numbered sentences, so its claim gets no quote and
  // checkClaim says why (not_retrieved, or quote_not_in_section).
  return (parsed.claims ?? []).map(({ sentences, ...claim }) => ({ ...claim, quote: quoteFrom(numbered.get(`${claim.docId}|${claim.section}`) ?? [], sentences) }));
}

// The sections the claim listing may point at: only those in force today. Offered a superseded
// version beside the current one, the listing credited a current fact to the old label, and a true
// answer was rewritten (5 of 29 claims, 27 Nov 2026). A claim that does come from the old label
// then finds no sentence to point at, so it still fails.
export const offeredSections = (retrieved: RetrievedSection[], today: string) =>
  retrieved.filter((s) => inForceDocuments(new Set([s.doc_id]), today).has(s.doc_id));

// What citeStep runs after the number check: list the claims, then review each.
export type ClaimCheck = (answer: string, retrieved: RetrievedSection[], asked: string, today: string) => Promise<CitationProblem[]>;

export function claimCheckWith(client: OpenAI): ClaimCheck {
  const judge = judgeWithModel(client);
  return async (answer, retrieved, asked, today) => {
    const claims = await extractClaims(client, answer, offeredSections(retrieved, today));
    const given = new Set(numbersIn(asked));
    return timed("claim_judge", () => reviewClaims(claims, { retrieved, today, given }, judge));
  };
}

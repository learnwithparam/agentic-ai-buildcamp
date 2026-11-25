import { contentKey, type ReviewStatus } from "../reviews";
import { Annotation, END, START, StateGraph, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { observeOpenAI } from "@langfuse/openai";
import { getActiveTraceId, observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import type OpenAI from "openai";
import { z } from "zod";
import { env } from "../env";
import { modelClient } from "../gateway";
import { inboxOf, userOf, type ReviewInbox } from "../graph";
import type { OpenFgaClient } from "@openfga/sdk";
import { checkableDocuments, fga } from "../permissions";
import { TENANTS, type Identity } from "../users";
import { CLAIMS, CONTENT_DRAFTS, type Claim, type ContentDraft } from "./records";

// Lesson 14. The fact-checker: every sentence of an email to doctors must be an approved claim for
// the country it goes to. It reuses the base the desk already has: model calls through the
// gateway (lesson 10), the company from the signed-in user and OpenFGA (lesson 11), and the
// reviewer inbox (lesson 13). Only its graph and its data are its own.
//
// The verdict is code. A sentence passes only when it is an approved claim word for word, because
// that is what approved means: a paraphrase of a claim is a new claim until a reviewer signs it.
// The model only suggests which approved claim a flagged sentence could be replaced with.

export type Verdict = "APPROVED" | "NOT_APPROVED_IN_COUNTRY" | "UNAPPROVED_CLAIM";
export type SentenceCheck = { sentence: string; verdict: Verdict; claim?: Claim; suggestion?: Claim };

export const COUNTRY_NAMES: Record<string, string> = { US: "the US", DE: "Germany", JP: "Japan" };
const countryName = (country: string) => COUNTRY_NAMES[country] ?? country;
export const cite = (claim: Claim) => `[approved-claims, ${claim.claimId}]`;

// Case, spacing and the closing full stop do not change a claim; every word does.
const normal = (text: string) => text.toLowerCase().replace(/\s+/g, " ").replace(/[\s.]+$/, "").trim();

export function checkSentence(sentence: string, country: string, claims: Claim[]): SentenceCheck {
  const same = claims.filter((claim) => normal(claim.text) === normal(sentence));
  const here = same.find((claim) => claim.country === country);
  if (here) return { sentence, verdict: "APPROVED", claim: here };
  if (same.length) {
    // Approved somewhere else. The fix to offer is the claim approved here for the same label section.
    const suggestion = claims.find((other) => other.country === country && other.section === same[0].section);
    return { sentence, verdict: "NOT_APPROVED_IN_COUNTRY", claim: same[0], suggestion };
  }
  return { sentence, verdict: "UNAPPROVED_CLAIM" };
}

// One sentence per item: list numbers, bullets and headings are not part of what the doctor reads as a claim.
export function splitSentences(text: string): string[] {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  return text
    .split("\n")
    .map((line) => line.trim().replace(/^(\d+\.|[-*])\s+/, ""))
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => [...segmenter.segment(line)].map((part) => part.segment.trim()).filter(Boolean));
}

// What a request asks to check: a saved draft by its id, or the text after "Check this sentence ...:".
export type FactCheckRequest = { text?: string; draftId?: string; country?: string };
// "for a German email" names the country the email goes to; without it, the writer's own country.
const COUNTRY_WORDS: Record<string, string> = { us: "US", german: "DE", germany: "DE", japanese: "JP", japan: "JP" };
export function readRequest(query: string): FactCheckRequest {
  const draftId = query.match(/\bdraft-email-[a-z0-9]+(?:-[a-z0-9]+)*\b/)?.[0];
  if (draftId) return { draftId };
  const word = query.match(/\bfor (?:an? )?(US|German|Germany|Japanese|Japan) email\b/i)?.[1];
  const colon = query.indexOf(":");
  const text = colon > 0 && /^\s*(fact-)?check\b/i.test(query) ? query.slice(colon + 1).trim() : query.trim();
  return { text, country: word ? COUNTRY_WORDS[word.toLowerCase()] : undefined };
}

export function suggestTool(ids: string[], count: number): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: "suggest_claims",
      description: "For each flagged sentence, the approved claim that says the same thing, or none.",
      parameters: {
        type: "object",
        properties: {
          suggestions: {
            type: "array",
            minItems: count,
            maxItems: count,
            items: {
              type: "object",
              properties: { sentence: { type: "integer", minimum: 1, maximum: count }, claim_id: { type: "string", enum: [...ids, "none"] } },
              required: ["sentence", "claim_id"],
              additionalProperties: false
            }
          }
        },
        required: ["suggestions"],
        additionalProperties: false
      }
    }
  };
}

const SuggestArgs = z.object({ suggestions: z.array(z.object({ sentence: z.number().int(), claim_id: z.string() })) });

export const SUGGEST_PROMPT = `You help a pharmaceutical marketing writer fix an email to doctors.
Each numbered sentence below is not an approved claim. For each one, name the approved claim that
makes the same point, so the writer can use the approved wording instead. If no approved claim makes
the same point, answer none. A claim on the same topic that says something different is none.
A superlative or comparison ("the best", "safer than") has no approved claim: none.`;

async function suggestClaims(openai: OpenAI, flagged: string[], claims: Claim[]): Promise<Array<Claim | undefined>> {
  const completion = await openai.chat.completions.create({
    model: env.openaiModel,
    temperature: 0,
    messages: [
      { role: "system", content: `${SUGGEST_PROMPT}\n\nApproved claims:\n${claims.map((claim) => `${claim.claimId}: ${claim.text}`).join("\n")}` },
      { role: "user", content: flagged.map((sentence, index) => `${index + 1}. ${sentence}`).join("\n") }
    ],
    tools: [suggestTool(claims.map((claim) => claim.claimId), flagged.length)],
    tool_choice: { type: "function", function: { name: "suggest_claims" } }
  });
  const call = completion.choices[0]?.message.tool_calls?.find((item) => item.type === "function" && item.function.name === "suggest_claims");
  if (!call || call.type !== "function") throw new Error("The fact-checker did not suggest claims.");
  const { suggestions } = SuggestArgs.parse(JSON.parse(call.function.arguments));
  return flagged.map((_sentence, index) => claims.find((claim) => claim.claimId === suggestions.find((item) => item.sentence === index + 1)?.claim_id));
}

// The report a writer, a reviewer and the dataset read. Fixed wording, so the codes are always there.
export function factCheckReport(input: { company: string; country: string; claims: Claim[]; checks: SentenceCheck[] }): string {
  const { company, country, claims, checks } = input;
  if (!claims.length) {
    return `INSUFFICIENT_CONTEXT: ${company} has no approved claims to check against, so this email cannot go out as written: none of its ${checks.length} sentence${checks.length === 1 ? "" : "s"} is an approved claim. The claims must be approved by your medical, legal and regulatory review first.`;
  }
  if (!checks.length) return "INSUFFICIENT_CONTEXT: there is no sentence to check.";
  const lines = checks.map((check, index) => {
    const quoted = `"${check.sentence}"`;
    if (check.verdict === "APPROVED") return `${index + 1}. APPROVED ${cite(check.claim!)}: ${quoted}`;
    if (check.verdict === "NOT_APPROVED_IN_COUNTRY") {
      const fix = check.suggestion ? ` Use ${cite(check.suggestion)} instead: "${check.suggestion.text}"` : "";
      return `${index + 1}. NOT_APPROVED_IN_COUNTRY ${cite(check.claim!)}: ${quoted} This claim is approved for ${countryName(check.claim!.country)}, not for ${countryName(country)}.${fix}`;
    }
    const fix = check.suggestion ? ` The closest approved claim is ${cite(check.suggestion)}: "${check.suggestion.text}"` : "";
    return `${index + 1}. UNAPPROVED_CLAIM: ${quoted} No approved claim says this.${fix}`;
  });
  const flagged = checks.filter((check) => check.verdict !== "APPROVED").length;
  const verdict = flagged
    ? `REVIEW_REQUIRED: ${flagged} of ${checks.length} sentences need a medical reviewer before this email is sent.`
    : `Every sentence is an approved claim for ${countryName(country)}. The email can go out as written.`;
  return [`Fact-check of an email for ${countryName(country)}, ${checks.length} sentences:`, ...lines, verdict].join("\n\n");
}

const FactState = Annotation.Root({
  request: Annotation<FactCheckRequest>(),
  country: Annotation<string>(),
  draft: Annotation<ContentDraft | null>(),
  sentences: Annotation<string[]>(),
  claims: Annotation<Claim[]>(),
  checks: Annotation<SentenceCheck[]>(),
  report: Annotation<string>(),
  itemId: Annotation<string | null>(),
  itemStatus: Annotation<ReviewStatus | null>()
});
type FactCheckState = typeof FactState.State;

export type FactCheckResult = Pick<FactCheckState, "country" | "draft" | "checks" | "report" | "itemId" | "itemStatus">;

// The OpenFGA client and the model client are passed in so a test can point the checker at its own store and a stand-in model.
export function createFactChecker({ client = fga, model = modelClient }: { client?: () => OpenFgaClient; model?: () => OpenAI } = {}) {
  const graph = new StateGraph(FactState)
    // What to check, for which country, against which claims. The claims are the company's own,
    // in every country, so a US claim in a German email is named as that, not as unknown.
    .addNode(
      "read",
      observe(
        async (state: FactCheckState, config: LangGraphRunnableConfig) => {
          const user = userOf(config);
          const draft = state.request.draftId ? (CONTENT_DRAFTS.find((item) => item.draftId === state.request.draftId && item.tenantId === user.tenantId) ?? null) : null;
          const documents = await checkableDocuments(user, client());
          return {
            draft,
            country: draft?.country ?? state.request.country ?? user.country,
            sentences: draft ? draft.sentences : splitSentences(state.request.text ?? ""),
            claims: CLAIMS.filter((claim) => documents.has(claim.docId))
          };
        },
        { name: "read", asType: "span", captureInput: false }
      )
    )
    .addNode("match", (state: FactCheckState) => ({ checks: state.sentences.map((sentence) => checkSentence(sentence, state.country, state.claims)) }))
    .addNode(
      "suggest",
      observe(
        async (state: FactCheckState) => {
          const here = state.claims.filter((claim) => claim.country === state.country);
          const flagged = state.checks.filter((check) => check.verdict === "UNAPPROVED_CLAIM");
          if (!flagged.length || !here.length) return {};
          const openai = observeOpenAI(model(), { generationName: "suggest-claims" });
          const suggestions = await suggestClaims(openai, flagged.map((check) => check.sentence), here);
          return { checks: state.checks.map((check) => (check.verdict === "UNAPPROVED_CLAIM" ? { ...check, suggestion: suggestions[flagged.indexOf(check)] } : check)) };
        },
        { name: "suggest", asType: "span", captureInput: false }
      )
    )
    // A flagged email goes to a medical reviewer of the same company, as a draft does (lesson 13).
    .addNode("write", async (state: FactCheckState, config: LangGraphRunnableConfig) => {
      const user = userOf(config);
      const report = factCheckReport({ company: TENANTS[user.tenantId]?.name ?? user.tenantId, country: state.country, claims: state.claims, checks: state.checks });
      const inbox = inboxOf(config);
      const threadId = config.configurable?.thread_id as string | undefined;
      if (!inbox || !threadId || !report.includes("REVIEW_REQUIRED")) return { report, itemId: null, itemStatus: null };
      const itemId = `email-${contentKey(user.tenantId, state.country, ...state.sentences)}`;
      const { status } = await inbox.submit({
        id: itemId,
        kind: "email",
        threadId,
        tenantId: user.tenantId,
        traceId: getActiveTraceId(),
        question: `An email for ${countryName(state.country)}${state.draft ? `: ${state.draft.title}` : ""}`,
        body: report
      });
      return { report, itemId, itemStatus: status };
    })
    .addEdge(START, "read")
    .addEdge("read", "match")
    .addEdge("match", "suggest")
    .addEdge("suggest", "write")
    .addEdge("write", END)
    .compile();

  return observe(
    async (input: { request: FactCheckRequest; user: Identity; inbox?: ReviewInbox; threadId?: string }): Promise<FactCheckResult> => {
      updateActiveObservation({ input: input.request });
      return propagateAttributes(
        {
          sessionId: input.threadId,
          userId: input.user.userId,
          metadata: { tenantId: input.user.tenantId, country: input.user.country },
          traceName: "hcp-fact-check",
          tags: ["langfuse-workshop", "hcp-fact-check"]
        },
        async () => {
          const result = await graph.invoke({ request: input.request }, { configurable: { user: input.user, inbox: input.inbox, thread_id: input.threadId } });
          updateActiveObservation({ output: result.report });
          return { country: result.country, draft: result.draft, checks: result.checks, report: result.report, itemId: result.itemId, itemStatus: result.itemStatus };
        }
      );
    },
    { name: "hcp-fact-check", asType: "agent", captureInput: false }
  );
}

export type FactChecker = ReturnType<typeof createFactChecker>;

import { randomUUID } from "node:crypto";
import { MemorySaver, type BaseCheckpointSaver, type LangGraphRunnableConfig } from "@langchain/langgraph";
import { observeOpenAI } from "@langfuse/openai";
import { getActiveTraceId, observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";
import { aiText, type AiMessage, type ChatMessage, type StreamEvent } from "../shared/messages";
import { evidenceOf } from "./citations";
import { env } from "./env";
import { checkInput, modelClient } from "./gateway";
import {
  agentStep,
  buildGraph,
  citeStep,
  fixedReply,
  readThread,
  reviewStep,
  runGraph,
  submitAdverseEvent,
  reportStep,
  submitDraftStep,
  toolsStep,
  userOf,
  type CitationOutcome,
  type Turn
} from "./graph";
import { LABEL_SECTIONS } from "./labels";
import { readableDocuments } from "./permissions";
import { PhiVault, pseudonymise, type SpanFinder } from "./phi";
import { reviewerDraft } from "./safety/draft";
import { labelLimits, limitsText } from "./safety/reference";
import { approvedUses, reportingProcedure, routeRequest, routerInput, safetyReply, stopReply, withFloor, withSecondPass } from "./tiers";
import type { Turn as SearchTurn } from "./rag/rewrite";
import { executeTool, TOOL_DEFINITIONS } from "./tools";
import type { ReviewItem } from "./reviews";
import { scriptUser, type Identity } from "./users";
import { DESK_PROMPT, deskFacts, fillDeskPrompt } from "./desk-prompt";
import { claimCheckWith } from "./citations.claims";
import { measureTurn, timed } from "./ops/meter";
import { scoreTurn } from "./ops/metrics";
import { answerRun } from "../shared/run";

// Lesson 01's prompt. The variants in scripts/prompt-variants.ts grow from it; since fix 3 the app
// falls back to DESK_PROMPT (src/server/desk-prompt.ts) when Langfuse is down.
// checkpoint-sync:begin system-prompt
export const SYSTEM_PROMPT = `You are the HCP Medical Information Agent for pharma_a.
Doctors and pharmacists ask you about CardioNex.

Call get_desk_rules first. Then call search_labels with the medicine, the patient detail and the country.
Make every search you need in that one step; after it you answer.
Answer from the label text you found, and cite each fact as [doc_id, section].
When asked to draft a reply to a doctor, write the full draft. A medical reviewer approves it before it is sent.

Keep it short and clear.
`;
// checkpoint-sync:end system-prompt

const langfuse = new LangfuseClient();

// Lesson 18. The release gate pins the agent to the one prompt version it tests. A pinned prompt
// that cannot be read is an error, never the built-in fallback, so a gate cannot pass on a prompt
// it did not test. Unpinned, the app reads the label it is deployed with, and falls back if
// Langfuse is down so a doctor still gets an answer.
let pinnedVersion: number | undefined;
export function usePromptVersion(version: number) {
  pinnedVersion = version;
}

async function getPrompt() {
  if (pinnedVersion !== undefined) return langfuse.prompt.get(env.langfusePromptName, { version: pinnedVersion });
  try { return await langfuse.prompt.get(env.langfusePromptName, { label: env.langfusePromptLabel }); }
  catch { return null; }
}

function latestQuestion(messages: ChatMessage[]) {
  return [...messages].reverse().find((message) => message.type === "human")?.content ?? "";
}

// What was said before the latest question: the doctor's words and the desk's replies, no tool
// output. search_labels reads it to write a follow-up out in full.
export function earlierTurns(messages: ChatMessage[]): SearchTurn[] {
  const last = messages.map((message) => message.type).lastIndexOf("human");
  return messages.slice(0, Math.max(last, 0)).flatMap((message): SearchTurn[] => {
    if (message.type === "human") return [{ role: "user", content: message.content }];
    if (message.type === "ai" && aiText(message)) return [{ role: "assistant", content: aiText(message) }];
    return [];
  });
}

const toolName = (tool: (typeof TOOL_DEFINITIONS)[number]) => (tool.type === "function" ? tool.function.name : "");

const outOfScope = (text: string): AiMessage => ({ id: `out-of-scope-${randomUUID()}`, type: "ai", content: [{ type: "text", text }], tool_calls: [] });

// Lesson 13. Identifiers leave the doctor's words before the trace, the model or the checkpoint
// sees them: each becomes a placeholder ([PATIENT_1]) that stays the same for the whole thread.
// Only the newest human messages arrive here; older ones were scrubbed on their turn. The map from
// placeholder back to the words stays in this process (the vault), and restore() reads it on the
// way out, so the doctor reads their own words and nothing stored holds them.
const vaults = new Map<string, PhiVault>();
const MAX_VAULTS = 5000;

function vaultFor(threadId: string): PhiVault {
  let vault = vaults.get(threadId);
  if (!vault) {
    vault = new PhiVault();
    if (vaults.size >= MAX_VAULTS) vaults.delete(vaults.keys().next().value!);
  }
  vaults.delete(threadId);
  vaults.set(threadId, vault);
  return vault;
}

async function scrubbed(messages: ChatMessage[] | undefined, vault: PhiVault, find?: SpanFinder): Promise<ChatMessage[] | undefined> {
  if (!messages) return messages;
  const out: ChatMessage[] = [];
  for (const message of messages) {
    out.push(message.type === "human" ? { ...message, content: (await pseudonymise(message.content, vault, find)).text } : message);
  }
  return out;
}
// Step 2B. Adds the record of how the reply in this update was made, under the reply's id.
type GraphUpdate = Partial<Parameters<typeof citeStep>[2]>;
function withRun(state: Parameters<typeof citeStep>[2], update: GraphUpdate, route = state.route, check: CitationOutcome | null = null): GraphUpdate {
  // The reply this update writes, else (a check that passed changes nothing) the answer just written.
  const reply = [...state.messages, ...(update.messages ?? [])].at(-1);
  if (reply?.type !== "ai" || reply.tool_calls.length) return update;
  // The chat folds a turn's tool calls and reply into one bubble, named by its first message, so
  // the record goes under every model message of the turn (seen in the browser, 26 Nov 2026).
  const turn = [...state.messages, ...(update.messages ?? [])];
  const ids = new Set(turn.slice(turn.map((message) => message.type).lastIndexOf("human") + 1).filter((message) => message.type === "ai").map((message) => message.id));
  const run = answerRun(state.messages, route, check);
  return { ...update, runs: Object.fromEntries([...ids].map((id) => [id, run])) };
}
const REMOVED = /\[(?:record number|email|ID number|phone number) removed\]|\[(?:MRN|EMAIL|ID|PHONE|PATIENT|DOB|ADDRESS)_\d+\]/;

// Lesson 21: the check's outcome is the span's output and a score on the trace, so Langfuse can
// count how often an answer was rewritten or withheld. Exported for npm run citations:replay,
// which runs this same node on answers already stored.
export const citeNode = observe(
  async (state: Parameters<typeof citeStep>[2], config: LangGraphRunnableConfig) => {
    // Fix 6: the answer and the sections it may cite, the two things the check compares.
    const answer = state.messages.at(-1);
    const sections = evidenceOf(state.messages).retrieved.map((hit) => `${hit.doc_id} ${hit.section}`);
    updateActiveObservation({ input: { answer: answer?.type === "ai" ? aiText(answer) : "", sections } });
    const langfusePrompt = await getPrompt();
    const openai = observeOpenAI(modelClient(), { generationName: "citation-rewrite", ...(langfusePrompt ? { langfusePrompt } : {}) });
    let outcome: CitationOutcome | undefined;
    const system = fillDeskPrompt(langfusePrompt?.prompt ?? DESK_PROMPT, deskFacts(userOf(config), state.today));
    const update = await citeStep(openai, system, state, config, (result) => (outcome = result), claimCheckWith(modelClient()));
    updateActiveObservation({ output: outcome });
    const traceId = getActiveTraceId();
    if (traceId && outcome) {
      langfuse.score.create({ traceId, name: "citations", value: outcome.outcome, dataType: "CATEGORICAL" });
      // Sent in the background: the doctor's answer never waits on Langfuse. Awaited, a slow or
      // dropped Langfuse connection failed the whole turn (seen 26 Nov 2026, status 0 on the flush).
      void langfuse.score.flush().catch((error: Error) => console.warn(`The citations score was not sent: ${error.message}`));
    }
    return { update: withRun(state, update, state.route, outcome ?? null), outcome };
  },
  { name: "cite", asType: "span", captureInput: false, captureOutput: false }
);

// One agent, two homes for its threads. The web app passes PostgresSaver, so a paused draft
// survives a restart; scripts pass MemorySaver, because their threads are thrown away after one answer.
export function createMedinfoAgent(checkpointer: BaseCheckpointSaver, options: { phiFinder?: SpanFinder } = {}) {
  const graph = buildGraph(
    {
      router: observe(
        async (state, config) => {
          // Fix 6: exactly what the router model is given, the latest message with earlier turns as context.
          updateActiveObservation({ input: routerInput(state.messages) });
          // Lesson 10: a request the desk never answers gets its reply here, with no model call.
          const refusal = checkInput(latestQuestion(state.messages));
          if (refusal) {
        const reply = outOfScope(refusal);
        return { messages: [reply], runs: { [reply.id]: answerRun(state.messages, { tier: "stop", reason: "outside what the desk answers, refused before any model call" }, null) } };
      }
          const readable = await readableDocuments(userOf(config));
          const openai = observeOpenAI(modelClient(), { generationName: "route" });
          const chosen = await timed("router", async () =>
            withSecondPass(
              routeRequest(openai, state.messages, approvedUses(readable, LABEL_SECTIONS)),
              observeOpenAI(modelClient(), { generationName: "safety-second-pass" }),
              env.openaiModel,
              latestQuestion(state.messages)
            )
          );
          const route = withFloor(chosen, latestQuestion(state.messages));
          updateActiveObservation({ output: route });
          return { route };
        },
        { name: "router", asType: "chain", captureInput: false }
      ),
      agent: observe(
        async (state, config) => {
          // Lesson 11: record the conversation, not the run config, which carries the signed-in doctor.
          // Fix 6: the question and the tools on offer; the generation inside holds every message sent.
          updateActiveObservation({ input: { question: latestQuestion(state.messages), tools: TOOL_DEFINITIONS.map(toolName), today: state.today } });
          const langfusePrompt = await getPrompt();
          const openai = observeOpenAI(modelClient(), langfusePrompt ? { langfusePrompt } : undefined);
          // Fix 3: the prompt is filled in for the signed-in doctor's company, country and day.
          const system = fillDeskPrompt(langfusePrompt?.prompt ?? DESK_PROMPT, deskFacts(userOf(config), state.today));
          return agentStep(openai, system, state, config);
        },
        { name: "agent", asType: "span", captureInput: false }
      ),
      tools: observe(
        (state, config) => {
          // Fix 6: the calls the model asked for, each with its arguments.
          const calls = state.messages.at(-1)?.type === "ai" ? (state.messages.at(-1) as AiMessage).tool_calls : [];
          updateActiveObservation({ input: calls.map((call) => ({ name: call.name, args: call.args })) });
          return toolsStep(state, (name, args) => executeTool(name, args, userOf(config), state.today, earlierTurns(state.messages)));
        },
        { name: "tools", asType: "span", captureInput: false }
      ),
      cite: async (state, config) => (await citeNode(state, config)).update,
      submit: (state, config) => submitDraftStep(state, config, getActiveTraceId()),
      review: reviewStep,
      report: observe(
        async (state, config) => {
          const readable = await readableDocuments(userOf(config));
          const draft = await timed("safety_report", () =>
            reviewerDraft(observeOpenAI(modelClient(), { generationName: "safety-extract" }), env.openaiModel, latestQuestion(state.messages), `ae-${String(config.configurable?.thread_id ?? "unknown")}`, limitsText(labelLimits(readable, userOf(config).country, state.today))).catch((error: Error) => `CASE DRAFT NOT MADE: ${error.message}`)
          );
          return reportStep(state, config, draft, getActiveTraceId());
        },
        { name: "report", asType: "span", captureInput: false }
      ),
      safety: observe(
        async (state, config) => {
          updateActiveObservation({ input: state.messages.at(-1) });
          const readable = await readableDocuments(userOf(config));
          const reply = safetyReply({
            asksForAdvice: state.route?.asksForAdvice ?? false,
            removedIdentifiers: REMOVED.test(latestQuestion(state.messages)) ? 1 : 0,
            procedure: reportingProcedure(readable, LABEL_SECTIONS)
          });
          await timed("safety_report", async () => {
            // A failed extraction never stops the report: the reviewer then reads the doctor's words alone.
            const draft = await reviewerDraft(observeOpenAI(modelClient(), { generationName: "safety-extract" }), env.openaiModel, latestQuestion(state.messages), `ae-${String(config.configurable?.thread_id ?? "unknown")}`, limitsText(labelLimits(readable, userOf(config).country, state.today))).catch((error: Error) => `CASE DRAFT NOT MADE: ${error.message}`);
            await submitAdverseEvent(state, config, `${reply}\n\n${draft}`, getActiveTraceId());
          });
          return withRun(state, fixedReply(state, reply));
        },
        { name: "safety", asType: "span", captureInput: false }
      ),
      stop: (state) => withRun(state, fixedReply(state, stopReply(state.route?.basis)))
    },
    checkpointer
  );

  const runTurn = observe(
    async (turn: Turn, emit: (event: StreamEvent) => void) => {
      const vault = vaultFor(turn.threadId);
      const cleaned = { ...turn, messages: await scrubbed(turn.messages, vault, options.phiFinder) };
      const traceId = getActiveTraceId();
      // Lesson 11: the trace records who asked by id, company and country only. The doctor's
      // name and email stay in Keycloak; the trace input is the thread and the new messages.
      updateActiveObservation({ input: { threadId: turn.threadId, messages: cleaned.messages, resume: turn.resume } });
      // The doctor reads their own words: placeholders go back in on the way out, after the trace and the checkpoint have what they keep.
      const emitRestored = (event: StreamEvent) => emit(vault.restoreDeep(event));
      const result = await propagateAttributes(
        {
          sessionId: turn.threadId,
          // Lesson 11: filter Langfuse by user, company or country to see one desk's traffic.
          userId: turn.user.userId,
          metadata: { tenantId: turn.user.tenantId, country: turn.user.country },
          traceName: turn.resume ? "hcp-medinfo-review-decision" : "hcp-medinfo-chat-turn",
          tags: ["langfuse-workshop", "hcp-medinfo"]
        },
        // Lesson 23: latency, cost and structured-output failures of this turn, as scores on its trace.
        () => measureTurn(() => runGraph(graph, cleaned, emitRestored), (metrics) => scoreTurn(langfuse, traceId, metrics))
      );
      return result;
    },
    { name: "hcp-medinfo-chat-turn", asType: "agent", captureInput: false }
  );

  return {
    runTurn,
    readThread: async (threadId: string) => {
      const thread = await readThread(graph, threadId);
      const vault = vaults.get(threadId);
      return vault ? vault.restoreDeep(thread) : thread;
    }
  };
}

export type MedinfoAgent = ReturnType<typeof createMedinfoAgent>;

// Scripts (the dataset run, the error-analysis replays): one answer per throwaway thread.
const scripted = createMedinfoAgent(new MemorySaver());
export const runMedinfoTurn = scripted.runTurn;

export type ConversationLine = { role: "user" | "assistant"; content: string };

// Scripts (the dataset run) ask one conversation without the chat UI. When the graph
// pauses for a reviewer, the draft waiting for review is the answer.
export async function answerConversation(lines: ConversationLine[], user: Identity = scriptUser()): Promise<string> {
  return (await answerWithSources(lines, user)).answer;
}

// The same answer, plus the tool results the model read before it wrote it. The faithfulness
// judge (lesson 09) checks the answer against these, the same text Langfuse shows as the
// tool messages in the final generation's input.
export async function answerWithSources(
  lines: ConversationLine[],
  user: Identity = scriptUser()
): Promise<{ answer: string; sources: string[]; tier: string | null }> {
  const messages: ChatMessage[] = lines.map((line, index) =>
    line.role === "user"
      ? { id: `line-${index}`, type: "human", content: line.content }
      : { id: `line-${index}`, type: "ai", content: [{ type: "text", text: line.content }], tool_calls: [] }
  );
  const result = await runMedinfoTurn({ threadId: `script-${randomUUID()}`, user, messages }, () => {});
  const answers = result.messages.filter((message): message is AiMessage => message.type === "ai" && aiText(message) !== "");
  const sources = result.messages.flatMap((message) => (message.type === "tool" ? [message.content] : []));
  return { answer: answers.length ? aiText(answers[answers.length - 1]) : "", sources, tier: result.route?.tier ?? null };
}

// Lesson 13. The audit trail: every decision is a Langfuse score on the trace that raised the
// item, saying what was decided and by whom (the reviewer's id, never their name).
export async function recordDecision(item: ReviewItem) {
  if (!item.traceId) return;
  langfuse.score.create({
    traceId: item.traceId,
    name: "review_decision",
    value: item.status,
    dataType: "CATEGORICAL",
    comment: item.note ?? undefined,
    metadata: { itemId: item.id, kind: item.kind, decidedBy: item.decidedBy, decidedAt: item.decidedAt }
  });
  await langfuse.score.flush();
}

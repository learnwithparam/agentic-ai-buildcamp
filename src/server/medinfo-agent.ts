import { randomUUID } from "node:crypto";
import { MemorySaver, type BaseCheckpointSaver } from "@langchain/langgraph";
import { observeOpenAI } from "@langfuse/openai";
import { getActiveTraceId, observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import { LangfuseClient } from "@langfuse/client";
import { aiText, type AiMessage, type ChatMessage, type StreamEvent } from "../shared/messages";
import { env } from "./env";
import { checkInput, modelClient } from "./gateway";
import {
  agentStep,
  buildGraph,
  fixedReply,
  readThread,
  reviewStep,
  runGraph,
  submitAdverseEvent,
  submitDraftStep,
  toolsStep,
  userOf,
  type Turn
} from "./graph";
import { LABEL_SECTIONS } from "./labels";
import { readableDocuments } from "./permissions";
import { scrubPhi } from "./phi";
import { approvedUses, reportingProcedure, routeRequest, safetyReply, stopReply, withFloor } from "./tiers";
import { executeTool } from "./tools";
import type { ReviewItem } from "./reviews";
import { scriptUser, type Identity } from "./users";

// Local fallback used when Langfuse isn't reachable or the prompt
// isn't published yet. scripts/publish-prompt.ts pushes this same
// string up to Langfuse.
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

const outOfScope = (text: string): AiMessage => ({ id: `out-of-scope-${randomUUID()}`, type: "ai", content: [{ type: "text", text }], tool_calls: [] });

// Lesson 13. Identifiers leave the doctor's words before the trace, the model or the checkpoint
// sees them. Only the newest human messages arrive here; older ones were scrubbed on their turn.
function scrubbed(messages: ChatMessage[] | undefined): ChatMessage[] | undefined {
  return messages?.map((message) => (message.type === "human" ? { ...message, content: scrubPhi(message.content).text } : message));
}
const REMOVED = /\[(?:record number|email|ID number|phone number) removed\]/;

// One agent, two homes for its threads. The web app passes PostgresSaver, so a paused draft
// survives a restart; scripts pass MemorySaver, because their threads are thrown away after one answer.
export function createMedinfoAgent(checkpointer: BaseCheckpointSaver) {
  const graph = buildGraph(
    {
      router: observe(
        async (state, config) => {
          updateActiveObservation({ input: state.messages.at(-1) });
          // Lesson 10: a request the desk never answers gets its reply here, with no model call.
          const refusal = checkInput(latestQuestion(state.messages));
          if (refusal) return { messages: [outOfScope(refusal)] };
          const readable = await readableDocuments(userOf(config));
          const openai = observeOpenAI(modelClient(), { generationName: "route" });
          const chosen = await routeRequest(openai, env.openaiModel, state.messages, approvedUses(readable, LABEL_SECTIONS));
          const route = withFloor(chosen, latestQuestion(state.messages));
          updateActiveObservation({ output: route });
          return { route };
        },
        { name: "router", asType: "chain", captureInput: false }
      ),
      agent: observe(
        async (state, config) => {
          // Lesson 11: record the conversation, not the run config, which carries the signed-in doctor.
          updateActiveObservation({ input: state });
          const langfusePrompt = await getPrompt();
          const openai = observeOpenAI(modelClient(), langfusePrompt ? { langfusePrompt } : undefined);
          return agentStep(openai, langfusePrompt?.prompt ?? SYSTEM_PROMPT, state, config);
        },
        { name: "agent", asType: "span", captureInput: false }
      ),
      tools: observe(
        (state, config) => {
          updateActiveObservation({ input: state });
          return toolsStep(state, (name, args) => executeTool(name, args, userOf(config), state.today));
        },
        { name: "tools", asType: "span", captureInput: false }
      ),
      submit: (state, config) => submitDraftStep(state, config, getActiveTraceId()),
      review: reviewStep,
      safety: observe(
        async (state, config) => {
          updateActiveObservation({ input: state.messages.at(-1) });
          const readable = await readableDocuments(userOf(config));
          const reply = safetyReply({
            asksForAdvice: state.route?.asksForAdvice ?? false,
            removedIdentifiers: REMOVED.test(latestQuestion(state.messages)) ? 1 : 0,
            procedure: reportingProcedure(readable, LABEL_SECTIONS)
          });
          await submitAdverseEvent(state, config, reply, getActiveTraceId());
          return fixedReply(state, reply);
        },
        { name: "safety", asType: "span", captureInput: false }
      ),
      stop: (state) => fixedReply(state, stopReply(state.route?.basis))
    },
    checkpointer
  );

  const runTurn = observe(
    (turn: Turn, emit: (event: StreamEvent) => void) => {
      const cleaned = { ...turn, messages: scrubbed(turn.messages) };
      // Lesson 11: the trace records who asked by id, company and country only. The doctor's
      // name and email stay in Keycloak; the trace input is the thread and the new messages.
      updateActiveObservation({ input: { threadId: turn.threadId, messages: cleaned.messages, resume: turn.resume } });
      return propagateAttributes(
        {
          sessionId: turn.threadId,
          // Lesson 11: filter Langfuse by user, company or country to see one desk's traffic.
          userId: turn.user.userId,
          metadata: { tenantId: turn.user.tenantId, country: turn.user.country },
          traceName: turn.resume ? "hcp-medinfo-review-decision" : "hcp-medinfo-chat-turn",
          tags: ["langfuse-workshop", "hcp-medinfo"]
        },
        () => runGraph(graph, cleaned, emit)
      );
    },
    { name: "hcp-medinfo-chat-turn", asType: "agent", captureInput: false }
  );

  return { runTurn, readThread: (threadId: string) => readThread(graph, threadId) };
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

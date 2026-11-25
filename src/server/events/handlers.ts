import PostalMime from "postal-mime";
import { getActiveTraceId, observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import { aiText, type AiMessage, type ChatMessage } from "../../shared/messages";
import { ANSWERS } from "../content/records";
import type { FactChecker } from "../content/fact-check";
import type { OutreachPlanner } from "../content/outreach";
import type { ReviewInbox } from "../graph";
import { LABEL_SECTIONS, replacedBy, statusOn } from "../labels";
import type { MedinfoAgent } from "../medinfo-agent";
import { scrubPhi } from "../phi";
import { eventWorker, type Identity } from "../users";
import { cite, dayOf, type EventResult, type HcpEvent } from "./events";

// Lesson 16. One handler per event type. Each starts the same graph a person would (the desk,
// the fact-checker, the outreach planner), as the company's event worker, so an event stops at
// the review and safety tiers exactly as a chat does. Nothing here decides an item.
//
// A queue delivers at least once, so a handler may run twice for one event. Every effect is
// keyed by the event: the thread an event opens is named after it, and a second run reads that
// thread instead of asking again. The inbox items are keyed by their content (lesson 14).

export type EventDesk = {
  agent: MedinfoAgent;
  factChecker: FactChecker;
  outreachPlanner: OutreachPlanner;
  // The inbox and the thread owner list. Left out by scripts, whose threads are thrown away.
  inbox?: ReviewInbox & { ensureThread(threadId: string, owner: Identity): Promise<void> };
};

const insufficient = (report: string): EventResult => ({ outcome: "INSUFFICIENT_CONTEXT", report: `INSUFFICIENT_CONTEXT: ${report}`, itemIds: [] });

const lastAnswer = (messages: ChatMessage[]) => {
  const answers = messages.filter((message): message is AiMessage => message.type === "ai" && aiText(message) !== "");
  return answers.length ? aiText(answers[answers.length - 1]) : "";
};

// Asks the desk one question on a thread named after the event. A thread that already holds an
// answer is read, not asked again, so a second delivery never makes a second draft or report.
async function askOnce(desk: EventDesk, threadId: string, user: Identity, question: string, today: string) {
  const done = lastAnswer((await desk.agent.readThread(threadId)).messages);
  if (done) return done;
  await desk.inbox?.ensureThread(threadId, user);
  const result = await desk.agent.runTurn({ threadId, user, inbox: desk.inbox, today, messages: [{ id: `${threadId}-question`, type: "human", content: question }] }, () => {});
  return lastAnswer(result.messages);
}

const threadFor = (event: HcpEvent, ...parts: string[]) => ["event", event.tenant_id, event.event_id, ...parts].join("-");

// A new label version is in force: every open answer that cites the version it replaced gets a
// corrected draft, which waits for a medical reviewer before anything reaches the doctor.
async function labelInForce(desk: EventDesk, event: Extract<HcpEvent, { type: "label.in_force" }>): Promise<EventResult> {
  const today = dayOf(event);
  const doc = LABEL_SECTIONS.find((section) => section.docId === event.doc_id && section.tenantId === event.tenant_id);
  if (!doc || statusOn(doc, today) !== "active") return insufficient(`${event.doc_id} is not a label of your company in force on ${today}.`);
  const replaced = event.replaces;
  if (!replaced || replacedBy(replaced, today) !== event.doc_id) {
    return { outcome: "HANDLED", report: `LABEL_IN_FORCE: ${event.doc_id} is in force from ${today}. It replaces no earlier label, so no answer needs a correction ${cite(event.event_id)}.`, itemIds: [] };
  }
  const stale = ANSWERS.filter((answer) => answer.tenantId === event.tenant_id && answer.status === "open" && answer.docId === replaced);
  const lines = [
    `LABEL_IN_FORCE: ${event.doc_id} replaced ${replaced} on ${today} ${cite(event.event_id)}. ${stale.length} open ${stale.length === 1 ? "answer cites" : "answers cite"} the old label.`
  ];
  for (const answer of stale) {
    const question = [
      `Draft a corrected reply to ${answer.hcpId}.`,
      `On ${answer.askedAt} they asked: "${answer.question}"`,
      `That answer cited ${answer.docId} ${answer.section}, which is no longer in force. Answer the same question from the label in force today.`
    ].join(" ");
    const draft = await askOnce(desk, threadFor(event, answer.answerId), eventWorker(answer.tenantId, answer.country), question, today);
    lines.push(`${answer.answerId} for ${answer.hcpId} [answers, ${answer.answerId}]:\n\n${draft}`);
  }
  return { outcome: "HANDLED", report: lines.join("\n\n"), itemIds: [] };
}

// An email reached the inbox. Its text goes to the desk as the doctor's words, so an adverse
// event takes the safety tier: identifiers removed, a report to the safety team, no advice.
async function emailReceived(desk: EventDesk, event: Extract<HcpEvent, { type: "email.received" }>): Promise<EventResult> {
  const email = await PostalMime.parse(event.raw_email);
  const text = (email.text ?? "").trim();
  if (!text) return insufficient("the email has no text to read.");
  const reply = await askOnce(desk, threadFor(event), eventWorker(event.tenant_id, event.country), text, dayOf(event));
  // The subject is scrubbed too: a sender may put the record number there.
  const subject = scrubPhi(email.subject ?? "(no subject)").text;
  return { outcome: "HANDLED", report: `EMAIL_RECEIVED: "${subject}" ${cite(event.event_id)}\n\n${reply}`, itemIds: [] };
}

// A draft email was uploaded: the fact-checker reads it, and a flagged one waits for a reviewer.
async function draftUploaded(desk: EventDesk, event: Extract<HcpEvent, { type: "draft.uploaded" }>): Promise<EventResult> {
  const user = eventWorker(event.tenant_id, event.country, ["sales-rep"]);
  const threadId = threadFor(event);
  if (desk.inbox) await desk.inbox.ensureThread(threadId, user);
  const result = await desk.factChecker({ request: { draftId: event.draft_id }, user, inbox: desk.inbox, threadId: desk.inbox ? threadId : undefined });
  if (!result.draft) return insufficient(`${event.draft_id} is not a draft of your company.`);
  return { outcome: "HANDLED", report: `DRAFT_UPLOADED: ${event.draft_id} ${cite(event.event_id)}\n\n${result.report}`, itemIds: result.itemId ? [result.itemId] : [] };
}

// The call center logged a call: the planner plans that doctor's next email again with the call
// included, so an opt-out holds the email before anyone sends it. The hold is the planner's rule,
// not the model's choice.
async function callLogged(desk: EventDesk, event: Extract<HcpEvent, { type: "call.logged" }>): Promise<EventResult> {
  const user = eventWorker(event.tenant_id, event.country, ["sales-rep"]);
  const threadId = threadFor(event);
  if (desk.inbox) await desk.inbox.ensureThread(threadId, user);
  const plan = await desk.outreachPlanner({ query: `Plan the next email to ${event.hcp_id}; the call center just logged ${event.call_id}.`, user, inbox: desk.inbox, threadId: desk.inbox ? threadId : undefined });
  return { outcome: "HANDLED", report: `CALL_LOGGED: ${event.call_id} for ${event.hcp_id} ${cite(event.event_id)}\n\n${plan.report}`, itemIds: plan.itemId ? [plan.itemId] : [] };
}

export function createEventHandler(desk: EventDesk) {
  return observe(
    // sender is the company whose signing key the delivery carried (webhook.ts).
    async (event: HcpEvent, sender: string): Promise<EventResult> => {
      updateActiveObservation({ input: { eventId: event.event_id, type: event.type, tenantId: event.tenant_id } });
      return propagateAttributes(
        {
          sessionId: `event-${sender}-${event.event_id}`,
          userId: `events-${sender}`,
          metadata: { tenantId: sender, eventType: event.type },
          traceName: "hcp-event",
          tags: ["langfuse-workshop", "hcp-event", event.type]
        },
        async () => {
          // The sender's key decides the company. An event about another company is refused
          // before anything reads it, and says nothing about that company.
          const result =
            event.tenant_id !== sender
              ? insufficient(`event ${event.event_id} is not about your company, so it was not read.`)
              : event.type === "label.in_force"
                ? await labelInForce(desk, event)
                : event.type === "email.received"
                  ? await emailReceived(desk, event)
                  : event.type === "draft.uploaded"
                    ? await draftUploaded(desk, event)
                    : await callLogged(desk, event);
          updateActiveObservation({ output: result.report });
          return { ...result, traceId: getActiveTraceId() };
        }
      );
    },
    { name: "hcp-event", asType: "agent", captureInput: false }
  );
}

export type EventHandler = ReturnType<typeof createEventHandler>;

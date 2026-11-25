import { Role, TaskState, type Message, type Part, type Task } from "@a2a-js/sdk";
import { AgentEvent, type AgentExecutor, type ExecutionEventBus, type RequestContext } from "@a2a-js/sdk/server";
import { submitEmail, type FactChecker, type SentenceCheck } from "../content/fact-check";
import type { OutreachPlanner } from "../content/outreach";
import type { ReviewInbox } from "../graph";
import type { Identity } from "../users";
import { identityOfCaller, type TaskReviews } from "./tasks";

// Lesson 15. The two agents from lesson 14, answering A2A tasks. Each turns the agent's result
// into a task state another agent can act on:
//   COMPLETED       the work is done, nothing waits.
//   INPUT_REQUIRED  the agent needs more before it is done: the sender's revision, or a human's
//                   decision in the inbox. The status message says which, in its metadata.
//   REJECTED        the agent will not do this for this caller, and says why.
// The verdicts stay the agents' own code (lesson 14). This file only maps them to states.

// What a task waits for, in the INPUT_REQUIRED status message's metadata.
export type Awaiting = { awaiting: "revision" } | { awaiting: "review"; itemId: string | null };

// Where both executors keep inbox items and their threads. Absent in the dataset runner, which
// never puts an item in a real inbox (the same rule as lesson 14's runner).
export type TaskInbox = { inbox: ReviewInbox & { ownsThread(threadId: string, userId: string): Promise<boolean>; createThread(threadId: string, owner: Identity): Promise<void> }; links: TaskReviews };

const text = (value: string): Part => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" });
const data = (value: unknown): Part => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });

export const textOf = (message: Message | undefined) =>
  (message?.parts ?? []).flatMap((part) => (part.content?.$case === "text" ? [part.content.value] : [])).join("\n");
export const dataOf = <T>(message: Message | undefined): Partial<T> =>
  Object.assign({}, ...(message?.parts ?? []).flatMap((part) => (part.content?.$case === "data" ? [part.content.value as object] : [])));

function agentMessage(context: RequestContext, words: string, metadata?: Record<string, unknown>): Message {
  return {
    messageId: crypto.randomUUID(),
    contextId: context.contextId,
    taskId: context.taskId,
    role: Role.ROLE_AGENT,
    parts: [text(words)],
    metadata,
    extensions: [],
    referenceTaskIds: []
  };
}

// The first event of every turn is the task as it stands, with the sender's message added.
function publishTask(context: RequestContext, bus: ExecutionEventBus) {
  const task: Task = context.task ?? {
    id: context.taskId,
    contextId: context.contextId,
    status: { state: TaskState.TASK_STATE_SUBMITTED, timestamp: new Date().toISOString(), message: undefined },
    artifacts: [],
    history: [context.userMessage],
    metadata: undefined
  };
  bus.publish(AgentEvent.task(task));
  bus.publish(AgentEvent.statusUpdate({ taskId: context.taskId, contextId: context.contextId, status: { state: TaskState.TASK_STATE_WORKING, timestamp: new Date().toISOString(), message: undefined }, metadata: undefined }));
}

function finish(context: RequestContext, bus: ExecutionEventBus, result: { state: TaskState; words: string; metadata?: Record<string, unknown>; report: string; details: unknown }) {
  bus.publish(
    AgentEvent.artifactUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      artifact: { artifactId: `${context.taskId}-report`, name: "report", description: "The agent's report, and the same as data.", parts: [text(result.report), data(result.details)], metadata: undefined, extensions: [] },
      append: false,
      lastChunk: true,
      metadata: undefined
    })
  );
  bus.publish(
    AgentEvent.statusUpdate({
      taskId: context.taskId,
      contextId: context.contextId,
      status: { state: result.state, timestamp: new Date().toISOString(), message: agentMessage(context, result.words, result.metadata) },
      metadata: undefined
    })
  );
  bus.finished();
}

// One thread per task, owned by the caller: the inbox item belongs to it, so the caller sees the
// item and never decides it (lesson 13's separation of duties).
export async function threadFor(store: TaskInbox | undefined, taskId: string, caller: Identity) {
  if (!store) return undefined;
  if (!(await store.inbox.ownsThread(taskId, caller.userId))) await store.inbox.createThread(taskId, caller);
  return taskId;
}

export class FactCheckExecutor implements AgentExecutor {
  constructor(
    private factChecker: FactChecker,
    private store?: TaskInbox
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus) {
    const caller = identityOfCaller(context.context);
    publishTask(context, bus);
    const { country } = dataOf<{ country: string }>(context.userMessage);
    const result = await this.factChecker({ request: { text: textOf(context.userMessage), country: country ?? caller.country }, user: caller, sessionId: context.contextId });
    const details = { country: result.country, checks: result.checks };
    if (result.report.startsWith("INSUFFICIENT_CONTEXT")) {
      return finish(context, bus, { state: TaskState.TASK_STATE_REJECTED, words: "There is nothing this company has approved to check this email against.", report: result.report, details });
    }
    const flagged = result.checks.filter((check) => check.verdict !== "APPROVED");
    if (!flagged.length) {
      return finish(context, bus, { state: TaskState.TASK_STATE_COMPLETED, words: "Every sentence is an approved claim.", report: result.report, details });
    }
    // The sender gets one chance to use the approved wording the checker found. A second flagged
    // turn, or a flag with no approved wording to offer, goes to a medical reviewer.
    if (!context.task && flagged.some((check) => check.suggestion)) {
      return finish(context, bus, {
        state: TaskState.TASK_STATE_INPUT_REQUIRED,
        words: "Some sentences are not approved claims. Send the email again on this task with the approved wording, and anything still flagged goes to a medical reviewer.",
        metadata: { awaiting: "revision" } satisfies Awaiting,
        report: result.report,
        details
      });
    }
    let itemId: string | null = null;
    const threadId = await threadFor(this.store, context.taskId, caller);
    if (this.store && threadId) {
      ({ itemId } = await submitEmail(this.store.inbox, { user: caller, threadId, country: result.country, sentences: result.checks.map((check) => check.sentence), report: result.report }));
      await this.store.links.link(itemId, context.taskId, caller);
    }
    finish(context, bus, {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      words: "A medical reviewer decides the flagged sentences. This task completes when they approve, and is rejected if they send it back.",
      metadata: { awaiting: "review", itemId } satisfies Awaiting,
      report: result.report,
      details
    });
  }

  async cancelTask() {
    // A check runs in one turn; there is nothing running to stop.
  }
}

export class OutreachExecutor implements AgentExecutor {
  constructor(
    private planner: OutreachPlanner,
    private store?: TaskInbox
  ) {}

  async execute(context: RequestContext, bus: ExecutionEventBus) {
    const caller = identityOfCaller(context.context);
    publishTask(context, bus);
    const threadId = await threadFor(this.store, context.taskId, caller);
    const plan = await this.planner({ query: textOf(context.userMessage), user: caller, inbox: this.store?.inbox, threadId, sessionId: context.contextId });
    const details = { hcpId: plan.hcpId, outcome: plan.outcome, step: plan.step, email: plan.email };
    if (plan.outcome === "INSUFFICIENT_CONTEXT") {
      return finish(context, bus, { state: TaskState.TASK_STATE_REJECTED, words: "There is no doctor this company calls on to plan for.", report: plan.report, details });
    }
    if (plan.outcome === "HOLD_OUTREACH") {
      return finish(context, bus, { state: TaskState.TASK_STATE_COMPLETED, words: "Nothing should go to this doctor now.", report: plan.report, details });
    }
    if (this.store && plan.itemId) await this.store.links.link(plan.itemId, context.taskId, caller);
    finish(context, bus, {
      state: TaskState.TASK_STATE_INPUT_REQUIRED,
      words: "A sales rep approves this step before it happens.",
      metadata: { awaiting: "review", itemId: plan.itemId } satisfies Awaiting,
      report: plan.report,
      details
    });
  }

  async cancelTask() {}
}

export type CheckDetails = { country: string; checks: SentenceCheck[] };

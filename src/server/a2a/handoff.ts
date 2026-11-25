import { randomUUID } from "node:crypto";
import { Role, TaskState, type AgentCard, type Message, type Part, type Task } from "@a2a-js/sdk";
import { ClientFactory, DefaultAgentCardResolver } from "@a2a-js/sdk/client";
import { observeOpenAI } from "@langfuse/openai";
import { observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import { context, propagation } from "@opentelemetry/api";
import type { OpenFgaClient } from "@openfga/sdk";
import type OpenAI from "openai";
import { z } from "zod";
import { approvedClaims, submitEmail, type SentenceCheck } from "../content/fact-check";
import { env } from "../env";
import { modelClient } from "../gateway";
import { fga } from "../permissions";
import { executeTool } from "../tools";
import type { Identity } from "../users";
import { A2A_AGENTS, a2aPath, SKILLS, type A2aAgentName } from "./cards";
import { dataOf, textOf, threadFor, type Awaiting, type CheckDetails, type TaskInbox } from "./executors";

// Lesson 15. The agent a rep talks to, handing work to the other two over A2A. It knows them only
// by their Agent Cards: the model picks a skill from the cards, and the code sends the task with
// the rep's own token, so the other agent answers for this rep's company and nobody else's.
//
// What the model decides: which skill, and the words of a draft, from the approved claims first. What the code decides: everything
// about the task. It revises a flagged draft once with the approved wording the fact-checker gave,
// and it never sends an email it drafted without a medical reviewer, even when every sentence passes.

const NONE = "none";

export const ROUTE_PROMPT = `You hand a sales rep's request to the one agent that does it.
The agents and their skills are below, from their Agent Cards. Pick the skill that does what the
rep asks, or none if no skill does.
Drafting an email is your own job, not another agent's. When the rep asks for an email to be
drafted and fact-checked, the skill is the fact-checking one: leave text_to_check empty, and say in
label_query what the email must state, so it can be looked up in the product label.
When the rep gives sentences to check, copy them exactly into text_to_check.`;

export const DRAFT_PROMPT = `You draft the claim sentences of an email from a pharmaceutical company to a doctor.
Write one sentence for each point the rep asks the email to make, and nothing else: no point the
rep did not ask for, even one the label puts next to it.
For each point, in this order:
1. Where one of the company's approved claims below makes the point, copy that claim word for word.
2. Where none does but a label excerpt states it, use the label's own words.
3. Where neither does, write the point as the rep asked. A fact-checker checks every sentence after
   you, so do not drop or soften it.
No greeting, no sign-off, no other sentences: the email template adds those.`;

export function routeTool(skills: string[]): OpenAI.Chat.Completions.ChatCompletionFunctionTool {
  return {
    type: "function",
    function: {
      name: "hand_off",
      description: "Hand the request to one agent's skill, or to none.",
      parameters: {
        type: "object",
        properties: {
          skill: { type: "string", enum: [...skills, NONE] },
          text_to_check: { type: "string", description: "Sentences the rep gave to check, word for word. Empty when the email is to be drafted." },
          label_query: { type: "string", description: "What a drafted email must state, as a product label search. Empty when nothing is drafted." }
        },
        required: ["skill", "text_to_check", "label_query"],
        additionalProperties: false
      }
    }
  };
}

const DRAFT_TOOL: OpenAI.Chat.Completions.ChatCompletionFunctionTool = {
  type: "function",
  function: {
    name: "draft_email",
    description: "The claim sentences of the email.",
    parameters: {
      type: "object",
      properties: { sentences: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } } },
      required: ["sentences"],
      additionalProperties: false
    }
  }
};

const RouteArgs = z.object({ skill: z.string(), text_to_check: z.string(), label_query: z.string() });
const DraftArgs = z.object({ sentences: z.array(z.string()).min(1) });

async function forced<T>(openai: OpenAI, schema: z.ZodType<T>, tool: OpenAI.Chat.Completions.ChatCompletionFunctionTool, system: string, user: string): Promise<T> {
  const completion = await openai.chat.completions.create({
    model: env.openaiModel,
    temperature: 0,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    tools: [tool],
    tool_choice: { type: "function", function: { name: tool.function.name } }
  });
  const call = completion.choices[0]?.message.tool_calls?.find((item) => item.type === "function" && item.function.name === tool.function.name);
  if (!call || call.type !== "function") throw new Error(`The hand-off agent did not call ${tool.function.name}.`);
  return schema.parse(JSON.parse(call.function.arguments));
}

// The state as the A2A spec names it, without the protocol's prefix: INPUT_REQUIRED, COMPLETED.
export const stateName = (state: TaskState | undefined) => (TaskState[state ?? TaskState.TASK_STATE_UNSPECIFIED] ?? "UNSPECIFIED").replace(/^TASK_STATE_/, "");

const text = (value: string): Part => ({ content: { $case: "text", value }, metadata: undefined, filename: "", mediaType: "text/plain" });
const data = (value: unknown): Part => ({ content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "application/json" });

function userMessage(parts: Part[], contextId: string, taskId = ""): Message {
  return { messageId: randomUUID(), contextId, taskId, role: Role.ROLE_USER, parts, metadata: undefined, extensions: [], referenceTaskIds: [] };
}

const reportOf = (task: Task) => textOf({ parts: task.artifacts.at(-1)?.parts ?? [] } as unknown as Message);
const detailsOf = <T>(task: Task) => dataOf<T>({ parts: task.artifacts.at(-1)?.parts ?? [] } as unknown as Message);
const awaitingOf = (task: Task) => task.status?.message?.metadata as Awaiting | undefined;

// The flagged sentences replaced with the approved wording the fact-checker offered; the rest kept.
export function revise(checks: SentenceCheck[]): { sentences: string[]; revised: number } {
  let revised = 0;
  const sentences = checks.map((check) => {
    if (check.verdict === "APPROVED" || !check.suggestion) return check.sentence;
    revised += 1;
    return check.suggestion.text;
  });
  return { sentences, revised };
}

export const AGENT_DRAFTED =
  "REVIEW_REQUIRED: an agent drafted this email, so a medical reviewer approves it before it is sent, even though every sentence is an approved claim.";

export type HandoffResult = { contextId: string; agent: A2aAgentName | null; tasks: Array<{ id: string; state: string }>; itemId: string | null; report: string };

export function createHandoffAgent({ model = modelClient, permissions = fga, fetchImpl }: { model?: () => OpenAI; permissions?: () => OpenFgaClient; fetchImpl?: typeof fetch } = {}) {
  const resolver = new DefaultAgentCardResolver(fetchImpl ? { fetchImpl } : undefined);
  const factory = new ClientFactory();

  return observe(
    async (input: { query: string; user: Identity; token: string; baseUrl: string; inbox?: TaskInbox["inbox"] }): Promise<HandoffResult> => {
      updateActiveObservation({ input: { query: input.query } });
      // One A2A context per hand-off, and the same id as the Langfuse session: every agent's trace
      // for this request is in one session.
      const contextId = randomUUID();
      return propagateAttributes(
        {
          sessionId: contextId,
          userId: input.user.userId,
          metadata: { tenantId: input.user.tenantId, country: input.user.country },
          traceName: "hcp-handoff",
          tags: ["langfuse-workshop", "hcp-handoff"]
        },
        async () => {
          const result = await handOff(input, contextId);
          updateActiveObservation({ output: result.report });
          return result;
        }
      );
    },
    { name: "hcp-handoff", asType: "agent", captureInput: false }
  );

  async function handOff(input: { query: string; user: Identity; token: string; baseUrl: string; inbox?: TaskInbox["inbox"] }, contextId: string): Promise<HandoffResult> {
    const openai = () => observeOpenAI(model(), { generationName: "handoff" });
    const cards = new Map<string, { name: A2aAgentName; card: AgentCard }>();
    for (const name of A2A_AGENTS) {
      const card = await resolver.resolve(new URL(`${a2aPath(name)}/`, input.baseUrl).href);
      for (const skill of card.skills) cards.set(skill.id, { name, card });
    }
    const listing = [...cards.entries()].map(([id, { card }]) => `- ${id} (agent ${card.name}): ${card.description} ${card.skills.find((skill) => skill.id === id)?.description ?? ""}`).join("\n");
    const route = await forced(openai(), RouteArgs, routeTool([...cards.keys()]), `${ROUTE_PROMPT}\n\nSkills:\n${listing}`, input.query);
    const chosen = cards.get(route.skill);
    if (!chosen) {
      return { contextId, agent: null, tasks: [], itemId: null, report: "INSUFFICIENT_CONTEXT: none of the agents this desk can hand work to does this. Ask the medical information desk." };
    }

    const client = await factory.createFromAgentCard(chosen.card);
    // The rep's own token goes with the task, and the trace context with it (the W3C traceparent).
    const send = async (parts: Part[], taskId?: string) => {
      const headers: Record<string, string> = { Authorization: `Bearer ${input.token}` };
      propagation.inject(context.active(), headers);
      const sent = await client.sendMessage({ tenant: "", message: userMessage(parts, contextId, taskId), configuration: undefined, metadata: undefined }, { serviceParameters: headers });
      if (!("status" in sent)) throw new Error(`The ${chosen.name} agent answered without a task.`);
      return sent as Task;
    };
    const timeline: string[] = [`Handed to the ${chosen.name} agent (skill ${route.skill}).`];
    const tasks: HandoffResult["tasks"] = [];
    const record = (task: Task, what: string) => {
      tasks.push({ id: task.id, state: stateName(task.status?.state) });
      timeline.push(`Task ${task.id}: ${stateName(task.status?.state)}, ${what}`);
    };

    if (route.skill === SKILLS.planOutreach) {
      const task = await send([text(input.query)]);
      record(task, textOf(task.status?.message));
      return { contextId, agent: chosen.name, tasks, itemId: (awaitingOf(task) as { itemId?: string } | undefined)?.itemId ?? null, report: finalReport(reportOf(task), task, timeline) };
    }

    // The fact-checker. The rep's own sentences, or a draft from the product label.
    let sentences = route.text_to_check.trim() ? [route.text_to_check.trim()] : [];
    if (!sentences.length) {
      // The company's approved claims for this country first, then the label for anything else.
      const claims = await approvedClaims(input.user, input.user.country, permissions());
      const labels = await executeTool("search_labels", { query: route.label_query || input.query }, input.user);
      const sources = `Approved claims:\n${claims.map((claim) => `- ${claim.text}`).join("\n") || "- none"}\n\nLabel excerpts:\n${JSON.stringify(labels)}`;
      ({ sentences } = await forced(openai(), DraftArgs, DRAFT_TOOL, `${DRAFT_PROMPT}\n\n${sources}`, input.query));
      timeline.push(`Drafted ${sentences.length} sentence${sentences.length === 1 ? "" : "s"} from the approved claims and the product label.`);
    }
    const parts = (lines: string[]) => [text(lines.join("\n")), data({ country: input.user.country })];
    let task = await send(parts(sentences));
    record(task, textOf(task.status?.message));
    if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED && awaitingOf(task)?.awaiting === "revision") {
      const { sentences: revisedSentences, revised } = revise(detailsOf<CheckDetails>(task).checks ?? []);
      timeline.push(`Replaced ${revised} flagged sentence${revised === 1 ? "" : "s"} with the approved wording the fact-checker gave.`);
      sentences = revisedSentences;
      task = await send(parts(sentences), task.id);
      record(task, textOf(task.status?.message));
    }
    let itemId = (awaitingOf(task) as { itemId?: string | null } | undefined)?.itemId ?? null;
    let report = reportOf(task);
    if (task.status?.state === TaskState.TASK_STATE_COMPLETED && route.text_to_check.trim() === "") {
      // Every sentence passed, and an agent wrote them. A medical reviewer still signs it off.
      // The reviewer reads the same reason the rep does.
      report = `${report}\n\n${AGENT_DRAFTED}`;
      if (input.inbox) {
        const threadId = (await threadFor({ inbox: input.inbox } as TaskInbox, task.id, input.user))!;
        ({ itemId } = await submitEmail(input.inbox, { user: input.user, threadId, country: input.user.country, sentences, report }));
      }
    }
    return { contextId, agent: chosen.name, tasks, itemId, report: finalReport(report, task, timeline) };
  }
}

// The last report only, so a sentence the fact-checker flagged and the drafter fixed is not quoted.
function finalReport(report: string, task: Task, timeline: string[]) {
  return [report, `Task state: ${stateName(task.status?.state)}. ${textOf(task.status?.message)}`, `How it was handed over:\n${timeline.map((line) => `- ${line}`).join("\n")}`].join("\n\n");
}

export type HandoffAgent = ReturnType<typeof createHandoffAgent>;

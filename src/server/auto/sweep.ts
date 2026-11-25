import { observeOpenAI } from "@langfuse/openai";
import { getActiveTraceId, observe, propagateAttributes, updateActiveObservation } from "@langfuse/tracing";
import type { OpenFgaClient } from "@openfga/sdk";
import type OpenAI from "openai";
import { z } from "zod";
import { PROFILES, recordOf, type HcpProfile } from "../content/records";
import { env } from "../env";
import { redraftAnswer, staleAnswers, type EventDesk } from "../events/handlers";
import { modelClient } from "../gateway";
import { fga, visibleHcps } from "../permissions";
import { sweepWorker, TENANTS } from "../users";
import { startOfDay, type AgentControls, type SpendReader } from "./limits";

// Lesson 17. The nightly sweep: an agent that works with nobody watching. Autonomy here is three
// limits, each enforced by code, never by asking the model to behave:
//   - scope: the sweep can only draft and plan. Its work goes to the same agents a person uses,
//     so every draft and every step lands in the inbox for a person to decide. It has no tool that
//     sends, ships or approves anything, and its identity holds no role that decides an item.
//   - budget: before every step it reads what it spent today from Langfuse, and stops at the limit.
//   - off switch: before every step it reads the company's kill switch row, and stops if paused.
//
// Its duties: every open answer that cites a label no longer in force gets a corrected draft,
// even when no event said so (an event can be lost; the sweep is the backstop). A person can add
// one instruction to a run, such as an outreach push; the sweep picks which doctors it covers and
// the outreach planner plans each one under its own rules, so a duplicate send is held by a rule.

export type SweepInput = { tenantId: string; today: string; runId: string; instruction?: string };
export type SweepOutcome = "DONE" | "BUDGET_STOP" | "AGENT_PAUSED";
export type SweepResult = { outcome: SweepOutcome; report: string; steps: number; spentUsd: number; itemIds: string[]; traceId?: string };

export type SweepDeps = {
  desk: EventDesk;
  controls: AgentControls;
  spend: SpendReader;
  model?: () => OpenAI;
  client?: () => OpenFgaClient;
  now?: () => Date;
};

const usd = (amount: number) => `${Number(amount.toFixed(4))} USD`;

const PickArgs = z.object({ hcp_ids: z.array(z.string()), reason: z.string() });

export const PICK_PROMPT = `You read one instruction a pharmaceutical company gave its nightly outreach sweep, and list the doctors it is about.
Each line is one doctor in the company's CRM: specialty, country, whether they agreed to email, their sample requests and the campaigns they were sent.
Choose by what the instruction names: a specialty, a country, a doctor's CRM id, a sample request or a campaign. Choose only from the list.
Do not leave a doctor out because a rule might stop the step: the planner checks every rule and holds what must not be sent.
If the instruction is about no doctor on the list, choose none.`;

// What the picker reads of one doctor: facts from the CRM files, never a judgement.
export function doctorLine(profile: HcpProfile) {
  const record = recordOf(profile);
  const samples = record.samples.map((sample) => `${sample.requestId} ${sample.status}`).join(", ") || "none";
  const sends = [...new Set(record.sends.map((send) => send.campaign))].join(", ") || "none";
  return `${profile.hcpId}: ${profile.specialty}, ${profile.country}, email consent ${profile.emailConsent ? "yes" : "no"}; sample requests: ${samples}; campaigns sent: ${sends}`;
}

// The one model call the sweep makes itself: which of the company's doctors an instruction covers.
// The ids it may return are the doctors OpenFGA lets the company see, so it cannot reach past them.
async function pickDoctors(openai: OpenAI, instruction: string, doctors: HcpProfile[]): Promise<{ ids: string[]; reason: string }> {
  const completion = await openai.chat.completions.create({
    model: env.openaiModel,
    temperature: 0,
    messages: [
      { role: "system", content: PICK_PROMPT },
      { role: "user", content: `Instruction: ${instruction}\n\nDoctors:\n${doctors.map(doctorLine).join("\n")}` }
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "pick_doctors",
          description: "The doctors the instruction is about.",
          parameters: {
            type: "object",
            properties: {
              hcp_ids: { type: "array", items: { type: "string", enum: doctors.map((doctor) => doctor.hcpId) } },
              reason: { type: "string", description: "One sentence: why these doctors." }
            },
            required: ["hcp_ids", "reason"],
            additionalProperties: false
          }
        }
      }
    ],
    tool_choice: { type: "function", function: { name: "pick_doctors" } }
  });
  const call = completion.choices[0]?.message.tool_calls?.find((item) => item.type === "function" && item.function.name === "pick_doctors");
  if (!call || call.type !== "function") throw new Error("The sweep did not pick any doctors.");
  const args = PickArgs.parse(JSON.parse(call.function.arguments));
  const known = new Set(doctors.map((doctor) => doctor.hcpId));
  return { ids: [...new Set(args.hcp_ids)].filter((id) => known.has(id)), reason: args.reason };
}

export function createSweep({ desk, controls, spend, model = modelClient, client = fga, now = () => new Date() }: SweepDeps) {
  return observe(
    async (input: SweepInput): Promise<SweepResult> => {
      const { tenantId, today, runId, instruction } = input;
      updateActiveObservation({ input: { tenantId, today, instruction: instruction ?? null } });
      return propagateAttributes(
        {
          sessionId: `sweep-${tenantId}-${runId}`,
          userId: sweepWorker(tenantId, "US").userId,
          metadata: { tenantId },
          traceName: "hcp-sweep",
          tags: ["langfuse-workshop", "hcp-sweep"]
        },
        async () => {
          const lines: string[] = [];
          const itemIds: string[] = [];
          let steps = 0;
          let spentUsd = 0;

          // Read before every step: the switch first (a pause wins over everything), then the budget.
          const stopBefore = async (): Promise<{ outcome: SweepOutcome; line: string } | null> => {
            const limits = await controls.get(tenantId);
            if (limits.paused) {
              const who = limits.changedBy ? `${limits.changedBy} paused it${limits.changedAt ? ` at ${limits.changedAt.slice(0, 16).replace("T", " ")} UTC` : ""}` : "it is paused";
              return { outcome: "AGENT_PAUSED", line: `AGENT_PAUSED: the sweep cannot go on: ${who}, so it stopped before step ${steps + 1}. Nothing more was done.` };
            }
            spentUsd = await spend(tenantId, startOfDay(now()));
            if (spentUsd >= limits.budgetUsd) {
              return {
                outcome: "BUDGET_STOP",
                line: `BUDGET_STOP: the sweep cannot go on today: it has spent ${usd(spentUsd)} of its ${usd(limits.budgetUsd)} budget, so it stopped before step ${steps + 1}. The rest waits for tomorrow's run.`
              };
            }
            return null;
          };

          // The work, listed by code before any model runs: what the sweep may touch is decided here.
          const stale = staleAnswers(tenantId, today);
          const work: Array<{ name: string; run: () => Promise<void> }> = stale.map(({ answer, inForce }) => ({
            name: `redraft ${answer.answerId}`,
            run: async () => {
              lines.push(await redraftAnswer(desk, answer, today, inForce, sweepWorker(tenantId, answer.country)));
            }
          }));

          if (instruction) {
            work.push({
              name: "pick doctors",
              run: async () => {
                const visible = await visibleHcps(sweepWorker(tenantId, "US"), client());
                const doctors = PROFILES.filter((profile) => profile.tenantId === tenantId && visible.has(profile.hcpId));
                const openai = observeOpenAI(model(), { generationName: "pick-doctors" });
                const picked = doctors.length ? await pickDoctors(openai, instruction, doctors) : { ids: [], reason: "Your company's CRM has no doctors." };
                lines.push(`INSTRUCTION: "${instruction}" covers ${picked.ids.length ? picked.ids.join(", ") : "no doctor"}. ${picked.reason}`);
                // Each doctor is one more step, so the limits are read again before each plan.
                for (const hcpId of picked.ids) {
                  const profile = doctors.find((doctor) => doctor.hcpId === hcpId)!;
                  work.push({
                    name: `plan ${hcpId}`,
                    run: async () => {
                      const threadId = `sweep-${tenantId}-${runId}-${hcpId}`;
                      await desk.inbox?.ensureThread(threadId, sweepWorker(tenantId, profile.country));
                      const plan = await desk.outreachPlanner({
                        query: `${instruction} This plan is for ${hcpId}.`,
                        user: sweepWorker(tenantId, profile.country),
                        inbox: desk.inbox,
                        threadId: desk.inbox ? threadId : undefined
                      });
                      if (plan.itemId) itemIds.push(plan.itemId);
                      lines.push(plan.report);
                    }
                  });
                }
              }
            });
          }

          // The limits are read before the first step even when there is no work, so a paused or
          // spent sweep always says so, and before every later step.
          let stop: { outcome: SweepOutcome; line: string } | null = null;
          for (let next = work.shift(); ; next = work.shift()) {
            if (!next && steps > 0) break;
            stop = await stopBefore();
            if (stop || !next) break;
            await next.run();
            steps++;
          }

          const company = TENANTS[tenantId]?.name ?? tenantId;
          const header =
            stop?.line ??
            `SWEEP_DONE: ${steps} ${steps === 1 ? "step" : "steps"} for ${company} on ${today}. ${
              stale.length ? `${stale.length} open ${stale.length === 1 ? "answer cites" : "answers cite"} a label no longer in force, redrafted for review.` : "No open answer cites a label no longer in force."
            } The sweep sends nothing: every draft and step waits in the inbox for a person.`;
          const report = [header, ...lines].join("\n\n");
          updateActiveObservation({ output: report });
          return { outcome: stop?.outcome ?? "DONE", report, steps, spentUsd, itemIds, traceId: getActiveTraceId() };
        }
      );
    },
    { name: "hcp-sweep", asType: "agent", captureInput: false }
  );
}

export type Sweep = ReturnType<typeof createSweep>;

// Mission Control: one door for the product teammates. A word list picks the path first.
// Only a question about a rival, the funnel or a briefing reaches a teammate.
import { COMPETITORS } from "../../../data/catalog/mission-control";
import { personNamed } from "../../../data/catalog/people";
import { type Tags, traced } from "../../../packages/core/src/telemetry";
import type { AgentResult } from "../../../src/grade";
import { answerAnalysis, loadSkills } from "./analyst";
import { reportOn, watchRival } from "./research";
import type { World } from "./rivals";
import { answerWorkspace } from "./workspace";

const OUTSIDE = "That is outside Mission Control. Ask me about a rival, the funnel or a briefing.";

export function rivalIn(question: string): string | undefined {
  const text = question.toLowerCase();
  return COMPETITORS.find((rival) => text.includes(rival.name.toLowerCase()))?.name;
}

async function analyse(question: string, tags: Tags): Promise<AgentResult | undefined> {
  return answerAnalysis(question, tags, await loadSkills());
}

async function research(rival: string, world: World): Promise<AgentResult> {
  const watch = await watchRival(rival, await world.fetchRival(rival));
  return { route: "answer", text: reportOn(watch), citations: [`${rival.toLowerCase()}-page`] };
}

export async function askMission(
  question: string,
  personName: string,
  world: World,
): Promise<AgentResult> {
  const person = personNamed(personName);
  const tags: Tags = { tenantId: person.tenant, agentName: "mission-control", person: person.name };
  return traced("mission.route", tags, async () => {
    const rival = rivalIn(question);
    if (rival !== undefined) return research(rival, world);
    const analysis = await analyse(question, tags);
    if (analysis !== undefined) return analysis;
    const workspace = await answerWorkspace(question, person.name);
    if (workspace !== undefined) return workspace;
    return { route: "template", text: OUTSIDE, citations: [] };
  });
}

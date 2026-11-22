// Mission Control: one door for the product teammates. A word list picks the path first.
// Only a question about a rival, the funnel or a briefing reaches a teammate.
import { COMPETITORS } from "../../../data/catalog/mission-control";
import { personNamed } from "../../../data/catalog/people";
import { type Tags, traced } from "../../../packages/core/src/telemetry";
import type { Intent } from "../../../src/golden";
import type { AgentResult } from "../../../src/grade";
import { reportOn, watchRival } from "./research";
import type { World } from "./rivals";

const OUTSIDE = "That is outside Mission Control. Ask me about a rival, the funnel or a briefing.";

export function rivalIn(question: string): string | undefined {
  const text = question.toLowerCase();
  return COMPETITORS.find((rival) => text.includes(rival.name.toLowerCase()))?.name;
}

export function decideMission(question: string): Intent {
  if (rivalIn(question) !== undefined) return "answer";
  return "template";
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
  return traced("mission.route", tags, async (setAttributes) => {
    const route = decideMission(question);
    setAttributes({ route });
    if (route === "template") return { route, text: OUTSIDE, citations: [] };
    const rival = rivalIn(question);
    if (rival !== undefined) return research(rival, world);
    return { route: "refuse", text: OUTSIDE, citations: [] };
  });
}

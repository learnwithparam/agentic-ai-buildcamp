// The team agent is the one door every surface uses. It picks a path, then answers.
// A numbers question goes to the BI tool. Any other question goes to the grounded agent.
import { BRANDS } from "../../../data/catalog/brands";
import type { DocumentType } from "../../../data/catalog/documents";
import { type Person, personNamed } from "../../../data/catalog/people";
import type { AgentResult } from "../../../src/grade";
import { can, canUse, type Verdict } from "./access";
import { ask } from "./ask";
import { answerData, type WriteQuery } from "./bi";
import { answerGrounded, type Generate } from "./grounded";
import { handle } from "./router";
import type { Tags } from "./telemetry";

export type Models = { generate: Generate; writeQuery: WriteQuery };
export type Agent = (question: string, personName: string) => Promise<AgentResult>;

const DATA_WORDS = ["prescription", "sales", "territor", "dispens", "units"];
const TYPE_WORDS: [string, DocumentType][] = [
  ["safety letter", "safety-letter"],
  ["study", "study-summary"],
  ["faq", "faq"],
];

export function isDataQuestion(question: string): boolean {
  const text = question.toLowerCase();
  return DATA_WORDS.some((word) => text.includes(word));
}

function brandIn(question: string): string | undefined {
  const text = question.toLowerCase();
  return BRANDS.find((brand) => text.includes(brand.name.toLowerCase()))?.name;
}

function typeIn(question: string): DocumentType {
  const text = question.toLowerCase();
  const found = TYPE_WORDS.find(([word]) => text.includes(word));
  if (found === undefined) return "label";
  return found[1];
}

// The wall comes before the work: a refused person never reaches a tool or a model.
function permit(person: Person, question: string): Verdict {
  const tool = isDataQuestion(question) ? "bi" : "documents";
  const use = canUse(person, tool);
  if (!use.allowed) return use;
  const brand = brandIn(question);
  if (brand === undefined) return use;
  return can(person, { brand, type: typeIn(question) });
}

export async function askTeam(
  question: string,
  personName: string,
  models: Models,
): Promise<AgentResult> {
  const person = personNamed(personName);
  const tags: Tags = { tenantId: person.tenant, agentName: "team", person: person.name };
  return handle(question, tags, async (text) => {
    const verdict = permit(person, text);
    if (!verdict.allowed) return { route: "refuse", text: verdict.reason, citations: [] };
    if (isDataQuestion(text)) return answerData(text, person.tenant, tags, models.writeQuery);
    return answerGrounded(text, tags, models.generate);
  });
}

// The live agent. Each model call is one traced call through the single door.
export function liveAgent(): Agent {
  return async (question, personName) => {
    const tags: Tags = { tenantId: personNamed(personName).tenant, agentName: "team" };
    const models: Models = {
      generate: async (prompt) => (await ask("smart", prompt, tags)).text,
      writeQuery: async (prompt) => (await ask("smart", prompt, tags)).text,
    };
    return askTeam(question, personName, models);
  };
}

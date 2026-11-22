// The team agent is the one door every surface uses. It picks a path, then answers.
// A numbers question goes to the BI tool. Any other question goes to the grounded agent.
import type { AgentResult } from "../../../src/grade";
import { ask } from "./ask";
import { answerData, type WriteQuery } from "./bi";
import { answerGrounded, type Generate } from "./grounded";
import { handle } from "./router";
import type { Tags } from "./telemetry";

export type Models = { generate: Generate; writeQuery: WriteQuery };
export type Agent = (question: string, tenantId: string) => Promise<AgentResult>;

const DATA_WORDS = ["prescription", "sales", "territor", "dispens", "units"];

export function isDataQuestion(question: string): boolean {
  const text = question.toLowerCase();
  return DATA_WORDS.some((word) => text.includes(word));
}

export async function askTeam(
  question: string,
  tenantId: string,
  models: Models,
): Promise<AgentResult> {
  const tags: Tags = { tenantId, agentName: "team" };
  return handle(question, tags, async (text) => {
    if (isDataQuestion(text)) return answerData(text, tenantId, tags, models.writeQuery);
    return answerGrounded(text, tags, models.generate);
  });
}

// The live agent. Each model call is one traced call through the single door.
export function liveAgent(): Agent {
  return async (question, tenantId) => {
    const tags: Tags = { tenantId, agentName: "team" };
    const models: Models = {
      generate: async (prompt) => (await ask("smart", prompt, tags)).text,
      writeQuery: async (prompt) => (await ask("smart", prompt, tags)).text,
    };
    return askTeam(question, tenantId, models);
  };
}

import type { AgentCard, AgentSkill } from "@a2a-js/sdk";

// Lesson 15. The contract each agent publishes: what it does, what it takes, and how to sign in.
// Another agent reads this card before it sends any work, so the card is the only thing the two
// sides share. Nothing in it is secret; the work itself needs a Keycloak token for the asking user.

export const A2A_AGENTS = ["fact-checker", "outreach-planner"] as const;
export type A2aAgentName = (typeof A2A_AGENTS)[number];

export const a2aPath = (name: A2aAgentName) => `/api/a2a/${name}`;
export const cardPath = (name: A2aAgentName) => `${a2aPath(name)}/.well-known/agent-card.json`;
// The only A2A routes open without a token: an agent reads the card to learn how to sign in.
export const A2A_PUBLIC_ROUTES = A2A_AGENTS.map((name) => `GET ${cardPath(name)}`);

// The skill ids another agent picks from. The handoff agent offers exactly these to its model.
export const SKILLS = { checkEmail: "check-email", planOutreach: "plan-outreach" } as const;

const skill = (id: string, name: string, description: string, examples: string[]): AgentSkill => ({
  id,
  name,
  description,
  tags: ["hcp", "pharma"],
  examples,
  inputModes: ["text/plain", "application/json"],
  outputModes: ["text/plain", "application/json"],
  securityRequirements: []
});

const SKILLS_OF: Record<A2aAgentName, { description: string; skill: AgentSkill }> = {
  "fact-checker": {
    description:
      "Checks every sentence of an email to doctors against the company's approved claims for the country it goes to. A flagged email waits for a medical reviewer.",
    skill: skill(
      SKILLS.checkEmail,
      "Fact-check an email",
      "Give the email's sentences as text, one per line, and the country as data {\"country\": \"US\"}. Returns each sentence's verdict with the approved claim it matches, or the approved claim to use instead.",
      ["Fact-check this sentence: Start CardioNex at 20mg once daily in adults with HFrEF."]
    )
  },
  "outreach-planner": {
    description:
      "Plans the next step with one doctor from the company's CRM: an email built from approved claims, a call, or a sample. Every step waits for a sales rep to approve it.",
    skill: skill(
      SKILLS.planOutreach,
      "Plan the next outreach step",
      "Give the question as text, naming the doctor by id (HCP-1001). Returns the step and why, citing the CRM records it read.",
      ["What should we do next with HCP-1001?"]
    )
  }
};

export function agentCard(name: A2aAgentName, appUrl: string, issuer: string): AgentCard {
  const { description, skill: offered } = SKILLS_OF[name];
  return {
    name,
    description,
    supportedInterfaces: [{ url: new URL(a2aPath(name), appUrl).href, protocolBinding: "JSONRPC", tenant: "", protocolVersion: "1.0" }],
    provider: { organization: "HCP Medical Information", url: appUrl },
    version: "1.0.0",
    documentationUrl: undefined,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    // The same Keycloak realm the app signs in with (lesson 11). The token says who is asking,
    // and the agent answers only for that person's company and country.
    securitySchemes: {
      keycloak: {
        scheme: {
          $case: "openIdConnectSecurityScheme",
          value: { description: "A Keycloak access token for the person asking, sent as a Bearer token.", openIdConnectUrl: `${issuer}/.well-known/openid-configuration` }
        }
      }
    },
    securityRequirements: [{ schemes: { keycloak: { list: [] } } }],
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    skills: [offered],
    signatures: [],
    iconUrl: undefined
  };
}

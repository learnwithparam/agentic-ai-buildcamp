import { CredentialsMethod, OpenFgaClient, type TupleKey } from "@openfga/sdk";
import { env } from "./env";
import type { HcpProfile } from "./content/records";
import type { LabelSection } from "./labels";
import type { Identity, Role } from "./users";

// Lesson 11. Which label text a doctor may read is decided by OpenFGA, from the rules in
// infra/openfga/model.fga. The search asks here first and never scores text outside the answer,
// so text the agent never receives, it cannot leak.

let client: OpenFgaClient | undefined;

export function fga() {
  if (!env.fgaStoreId || !env.fgaModelId || !env.fgaApiToken) {
    throw new Error("OpenFGA is not configured. Run npm run identity:setup (lesson 11).");
  }
  client ??= new OpenFgaClient({
    apiUrl: env.fgaApiUrl,
    storeId: env.fgaStoreId,
    // Pinned: a model written later never changes what this build allows until you pin it here.
    authorizationModelId: env.fgaModelId,
    credentials: { method: CredentialsMethod.ApiToken, config: { token: env.fgaApiToken } }
  });
  return client;
}

// The doctor's facts, from the verified token, sent with the question instead of stored in
// OpenFGA. Keycloak stays the one place a doctor's company and country are kept.
export function doctorTuples(user: Identity): TupleKey[] {
  return [
    { user: `user:${user.userId}`, relation: "member", object: `company:${user.tenantId}` },
    { user: `user:${user.userId}`, relation: "doctor", object: `country:${user.country}` }
  ];
}

const ROLE_RELATION: Record<Role, string> = {
  "medical-reviewer": "medical_reviewer",
  "safety-reviewer": "safety_reviewer",
  "sales-rep": "sales_rep",
  "sweep-agent": "sweep_agent",
  analyst: "analyst"
};

// Lesson 13. A reviewer's role, from the same verified token: the Keycloak realm role says what
// they review, the organization says for which company.
export function reviewerTuples(user: Identity): TupleKey[] {
  return user.roles.map((role) => ({ user: `user:${user.userId}`, relation: ROLE_RELATION[role], object: `company:${user.tenantId}` }));
}

// The document facts OpenFGA stores: whose it is, and where it is approved. Derived from the
// label library itself, so adding a document needs no second edit.
export function documentTuples(sections: LabelSection[]): TupleKey[] {
  const documents = new Map(sections.map((section) => [section.docId, section]));
  return [...documents.values()]
    .sort((a, b) => a.docId.localeCompare(b.docId))
    .flatMap((doc) => [
      { user: `company:${doc.tenantId}`, relation: "owner", object: `document:${doc.docId}` },
      { user: `country:${doc.country}`, relation: "approved_in", object: `document:${doc.docId}` }
    ]);
}

// The ids of every document this doctor may read.
export async function readableDocuments(user: Identity, client: OpenFgaClient = fga()): Promise<Set<string>> {
  const { objects } = await client.listObjects({
    user: `user:${user.userId}`,
    relation: "can_read",
    type: "document",
    contextualTuples: doctorTuples(user)
  });
  return new Set(objects.map((object) => object.replace(/^document:/, "")));
}

// Fix 0. Every document of the doctor's own company, in any country, for the label lookup tools.
export async function companyDocuments(user: Identity, client: OpenFgaClient = fga()): Promise<Set<string>> {
  const { objects } = await client.listObjects({
    user: `user:${user.userId}`,
    relation: "can_read_abroad",
    type: "document",
    contextualTuples: doctorTuples(user)
  });
  return new Set(objects.map((object) => object.replace(/^document:/, "")));
}

// Lesson 22. Each company's sales data is one dataset, owned by that company.
export const salesDataset = (tenantId: string) => `dataset:sales_${tenantId}`;
export function datasetTuples(tenantIds: string[]): TupleKey[] {
  return tenantIds.map((tenantId) => ({ user: `company:${tenantId}`, relation: "owner", object: salesDataset(tenantId) }));
}

// Lesson 22. May this user ask the insights agent about their company's sales? The analyst role
// and the company come from the token; OpenFGA holds which company owns which dataset.
export async function canQuerySales(user: Identity, client: OpenFgaClient = fga()): Promise<boolean> {
  const { allowed } = await client.check({
    user: `user:${user.userId}`,
    relation: "can_query",
    object: salesDataset(user.tenantId),
    contextualTuples: reviewerTuples(user)
  });
  return Boolean(allowed);
}

// Lesson 14. Which company's reps call on each doctor, from the CRM's own profiles.
export function hcpTuples(profiles: HcpProfile[]): TupleKey[] {
  return profiles.map((profile) => ({ user: `company:${profile.tenantId}`, relation: "owner", object: `hcp:${profile.hcpId}` }));
}

async function objectIds(user: Identity, relation: string, type: string, client: OpenFgaClient) {
  // The staff roles come from the token too, so a sales rep's or reviewer's reach is checked here.
  const contextualTuples = [...doctorTuples(user), ...reviewerTuples(user)];
  const { objects } = await client.listObjects({ user: `user:${user.userId}`, relation, type, contextualTuples });
  return new Set(objects.map((object) => object.slice(type.length + 1)));
}

// Lesson 14. The documents whose claims this user's fact-check compares against: their own
// company's, in every country.
export function checkableDocuments(user: Identity, client: OpenFgaClient = fga()) {
  return objectIds(user, "can_check_against", "document", client);
}

// Lesson 14. The doctors whose profile this user may plan outreach for.
export function visibleHcps(user: Identity, client: OpenFgaClient = fga()) {
  return objectIds(user, "can_view", "hcp", client);
}

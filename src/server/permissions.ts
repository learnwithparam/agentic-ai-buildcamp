import { CredentialsMethod, OpenFgaClient, type TupleKey } from "@openfga/sdk";
import { env } from "./env";
import type { LabelSection } from "./labels";
import type { Identity } from "./users";

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

// Lesson 13. A reviewer's role, from the same verified token: the Keycloak realm role says what
// they review, the organization says for which company.
export function reviewerTuples(user: Identity): TupleKey[] {
  return user.roles.map((role) => ({
    user: `user:${user.userId}`,
    relation: role === "medical-reviewer" ? "medical_reviewer" : "safety_reviewer",
    object: `company:${user.tenantId}`
  }));
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

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { AgentCard } from "@a2a-js/sdk";
import { noModelCall } from "../../../scripts/no-model-call";
import type { SentenceCheck } from "../content/fact-check";
import { CLAIMS } from "../content/records";
import { C02, ISSUER, startA2aApp } from "./a2a-harness";
import { A2A_AGENTS, a2aPath, cardPath } from "./cards";
import { revise } from "./handoff";
import { settledTask } from "./tasks";

// Lesson 15. What the A2A servers promise in code alone: the cards, the sign-in, the refusals and
// who a decision names. Every refusal here comes before any model call, so the model factory
// fails the test if it is called. The hand-offs on the real model are a2a.live.ts.

let app: Awaited<ReturnType<typeof startA2aApp>>;
before(async () => {
  app = await startA2aApp(noModelCall);
});
after(() => app.close());

const sendBody = (params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: { message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: C02 }] }, ...params }
});

test("each agent publishes its card without a token, naming its skill and the Keycloak sign-in", async () => {
  for (const name of A2A_AGENTS) {
    const response = await fetch(app.base + cardPath(name));
    assert.equal(response.status, 200, name);
    const card = await response.json();
    assert.equal(card.name, name);
    assert.equal(card.skills.length, 1);
    assert.equal(card.supportedInterfaces[0].url, app.base + a2aPath(name));
    // The A2A JSON form, so any client that follows the spec reads where to sign in.
    assert.equal(card.securitySchemes.keycloak.openIdConnectSecurityScheme.openIdConnectUrl, `${ISSUER}/.well-known/openid-configuration`);
    const scheme = AgentCard.fromJSON(card).securitySchemes.keycloak?.scheme;
    assert.equal(scheme?.$case, "openIdConnectSecurityScheme", JSON.stringify(card.securitySchemes));
  }
});

test("work without a Keycloak token is refused, and the refusal says where to sign in", async () => {
  const response = await app.rpc(sendBody());
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", new RegExp(`Bearer realm="${ISSUER}"`));
  assert.equal((await app.rpc(sendBody(), { Authorization: "Bearer not-a-token" })).status, 401);
});

test("a request that names its own tenant is refused: the company comes from the token", async () => {
  const response = await app.rpc(sendBody({ tenant: "pharma_a" }), { Authorization: `Bearer ${await app.token(app.people.okafor)}` });
  assert.equal(response.status, 400);
});

test("a page on another site cannot send work, even with a token", async () => {
  const response = await app.rpc(sendBody(), { Authorization: `Bearer ${await app.token(app.people.rivera)}`, Origin: "https://evil.example" });
  assert.equal(response.status, 403);
});

test("a revision swaps only a flagged sentence that has approved wording, and counts the swaps", () => {
  const c02 = CLAIMS.find((claim) => claim.claimId === "C-02")!;
  const checks: SentenceCheck[] = [
    { sentence: C02, verdict: "APPROVED", claim: c02 },
    { sentence: "Start CardioNex at 20 mg daily in HFrEF adults.", verdict: "UNAPPROVED_CLAIM", suggestion: c02 },
    { sentence: "CardioNex is the best heart failure medicine available today.", verdict: "UNAPPROVED_CLAIM" }
  ];
  assert.deepEqual(revise(checks), { sentences: [C02, c02.text, checks[2].sentence], revised: 1 });
});

test("a decision names who made it: a sales rep for an outreach step, a medical reviewer for an email", () => {
  const task = { id: "t-1", contextId: "c-1", status: undefined, artifacts: [], history: [], metadata: undefined } as unknown as Parameters<typeof settledTask>[0];
  const item = (kind: "outreach" | "email", status: "approved" | "rejected") =>
    ({ id: "i-1", kind, status, note: null }) as unknown as Parameters<typeof settledTask>[1];
  const words = (kind: "outreach" | "email", status: "approved" | "rejected") => {
    const part = settledTask(task, item(kind, status)).status?.message?.parts[0]?.content;
    return part?.$case === "text" ? part.value : "";
  };
  assert.equal(words("outreach", "approved"), "A sales rep approved the step.");
  assert.equal(words("email", "rejected"), "A medical reviewer sent the email back.");
});

import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { NodeSDK, tracing } from "@opentelemetry/sdk-node";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type OpenAI from "openai";

// Lesson 15. The two agents as A2A servers and the agent that hands work to them, end to end:
// the SDK's own client, signed tokens, a real Postgres for the tasks and the inbox, and a real
// OpenFGA store made for the test. The model is a stand-in, so nothing here is a paid call.

const exporter = new tracing.InMemorySpanExporter();
const processor = new tracing.SimpleSpanProcessor(exporter);
const sdk = new NodeSDK({ spanProcessors: [processor] });
sdk.start();

const { env } = await import("../env");
const { createTestStore } = await import("../../../scripts/fga-model");
const { createApp } = await import("../app");
const { createAuth } = await import("../auth");
const { createPool, migrate } = await import("../db");
const { createFactChecker } = await import("../content/fact-check");
const { createOutreachPlanner } = await import("../content/outreach");
const { ReviewStore } = await import("../reviews");
const { createHandoffAgent } = await import("./handoff");
const { createTaskStore, settledTask, TaskReviews } = await import("./tasks");
const { A2A_AGENTS, a2aPath, cardPath } = await import("./cards");
const { ClientFactory } = await import("@a2a-js/sdk/client");
const { AgentCard, TaskState } = await import("@a2a-js/sdk");

if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

const ISSUER = "https://keycloak.test/realms/medinfo";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "kc-1", alg: "RS256", use: "sig" };
const run = crypto.randomUUID().slice(0, 8);
const person = (sub: string, tenant: string, roles: string[]): JWTPayload => ({
  sub: `${sub}-${run}`,
  name: sub,
  email: `${sub}@example.com`,
  organization: [tenant],
  country: "US",
  realm_access: { roles: ["default-roles-medinfo", ...roles] }
});
const rivera = person("kc-rivera", "pharma_a", ["sales-rep"]);
const nair = person("kc-nair", "pharma_a", ["sales-rep"]);
const chen = person("kc-chen", "pharma_a", ["medical-reviewer"]);
const okafor = person("kc-okafor", "pharma_b", ["sales-rep"]);
const token = (claims: JWTPayload) =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "kc-1" }).setIssuer(ISSUER).setAudience("medinfo-api").setIssuedAt().setExpirationTime("5m").sign(privateKey);

// The stand-in answers each forced tool call from a script the test sets.
const script: Record<string, unknown> = {};
const model = {
  chat: {
    completions: {
      create: async (body: { tool_choice: { function: { name: string } } }) => {
        const name = body.tool_choice.function.name;
        assert.ok(name in script, `no stand-in answer for ${name}`);
        return { choices: [{ message: { tool_calls: [{ id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(script[name]) } }] } }] };
      }
    }
  }
} as unknown as OpenAI;

const BEST = "CardioNex is the best heart failure medicine available today.";
const PARAPHRASE = "Start CardioNex at 20 mg daily in HFrEF adults.";
const C02 = "Start CardioNex at 20mg once daily in adults with HFrEF.";

const pool = createPool(env.testDatabaseUrl);
let base = "";
let close = () => {};
let dropStore = async () => {};
before(async () => {
  await migrate(pool);
  const store = await createTestStore(env.fgaApiUrl, env.fgaApiToken);
  env.fgaStoreId = store.storeId;
  env.fgaModelId = store.modelId;
  dropStore = async () => void (await store.client.deleteStore());
  // The agent card names the app's own address, so the server listens before the app is made.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({
    issuer: ISSUER,
    audience: "medinfo-api",
    clientId: "medinfo-chat",
    clientSecret: "test-client-secret",
    appUrl: base,
    sessions: {} as never,
    keys: createLocalJWKSet({ keys: [jwk] }),
    client: async () => {
      throw new Error("not used");
    }
  });
  const tasks = createTaskStore(pool);
  const desk = {
    agent: {} as never,
    factChecker: createFactChecker({ model: () => model }),
    outreachPlanner: createOutreachPlanner({ model: () => model }),
    reviews: new ReviewStore(pool),
    recordDecision: async () => {},
    a2a: { store: tasks, links: new TaskReviews(pool, tasks), handoff: createHandoffAgent({ model: () => model }) }
  };
  server.on("request", createApp(auth, desk));
  close = () => server.close();
});
after(async () => {
  close();
  const owners = [rivera, nair, chen, okafor].map((claims) => claims.sub);
  await pool.query("DELETE FROM a2a_task_reviews WHERE owner = ANY($1)", [owners]);
  await pool.query("DELETE FROM review_requests WHERE thread_id IN (SELECT thread_id FROM threads WHERE owner_id = ANY($1))", [owners]).catch(() => {});
  await pool.query("DELETE FROM review_items WHERE thread_id IN (SELECT thread_id FROM threads WHERE owner_id = ANY($1))", [owners]);
  await pool.query("DELETE FROM threads WHERE owner_id = ANY($1)", [owners]);
  await pool.query("DELETE FROM a2a_tasks WHERE owner LIKE $1", [`%-${run}`]);
  await pool.end();
  await dropStore();
  await sdk.shutdown();
});

async function call(claims: JWTPayload, path: string, body?: unknown) {
  const response = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${await token(claims)}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: response.status, json: (await response.json()) as Record<string, unknown> };
}
type Handoff = { contextId: string; agent: string | null; tasks: Array<{ id: string; state: string }>; itemId: string | null; report: string };
const handOff = async (claims: JWTPayload, query: string) => {
  const { status, json } = await call(claims, "/api/handoffs", { query });
  assert.equal(status, 200, JSON.stringify(json));
  return json as unknown as Handoff;
};
async function getTask(claims: JWTPayload, id: string) {
  const card = await (await fetch(base + cardPath("fact-checker"))).json();
  const client = await new ClientFactory().createFromAgentCard(card);
  return client.getTask({ tenant: "", id, historyLength: 0 }, { serviceParameters: { Authorization: `Bearer ${await token(claims)}` } });
}
const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  fetch(base + a2aPath("fact-checker"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
const sendBody = (params: Record<string, unknown> = {}) => ({
  jsonrpc: "2.0",
  id: 1,
  method: "SendMessage",
  params: { message: { messageId: "m-1", role: "ROLE_USER", parts: [{ text: C02 }] }, ...params }
});

test("each agent publishes its card without a token, naming its skill and the Keycloak sign-in", async () => {
  for (const name of A2A_AGENTS) {
    const response = await fetch(base + cardPath(name));
    assert.equal(response.status, 200, name);
    const card = await response.json();
    assert.equal(card.name, name);
    assert.equal(card.skills.length, 1);
    assert.equal(card.supportedInterfaces[0].url, base + a2aPath(name));
    // The A2A JSON form, so any client that follows the spec reads where to sign in.
    assert.equal(card.securitySchemes.keycloak.openIdConnectSecurityScheme.openIdConnectUrl, `${ISSUER}/.well-known/openid-configuration`);
    const scheme = AgentCard.fromJSON(card).securitySchemes.keycloak?.scheme;
    assert.equal(scheme?.$case, "openIdConnectSecurityScheme", JSON.stringify(card.securitySchemes));
  }
});

test("work without a Keycloak token is refused, and the refusal says where to sign in", async () => {
  const response = await rpc(sendBody());
  assert.equal(response.status, 401);
  assert.match(response.headers.get("www-authenticate") ?? "", new RegExp(`Bearer realm="${ISSUER}"`));
  assert.equal((await rpc(sendBody(), { Authorization: "Bearer not-a-token" })).status, 401);
});

test("a request that names its own tenant is refused: the company comes from the token", async () => {
  const response = await rpc(sendBody({ tenant: "pharma_a" }), { Authorization: `Bearer ${await token(okafor)}` });
  assert.equal(response.status, 400);
});

test("a page on another site cannot send work, even with a token", async () => {
  const response = await rpc(sendBody(), { Authorization: `Bearer ${await token(rivera)}`, Origin: "https://evil.example" });
  assert.equal(response.status, 403);
});

test("a flag with no approved wording waits for a medical reviewer, whose decision completes the task", async () => {
  Object.assign(script, { hand_off: { skill: "check-email", text_to_check: "", label_query: "CardioNex heart failure" }, draft_email: { sentences: [BEST] }, suggest_claims: { suggestions: [{ sentence: 1, claim_id: "none" }] } });
  const result = await handOff(rivera, "Draft an email saying CardioNex is the best heart failure medicine, and have it fact-checked.");
  assert.equal(result.agent, "fact-checker");
  assert.match(result.report, /UNAPPROVED_CLAIM/);
  assert.match(result.report, /Task state: INPUT_REQUIRED/);
  assert.deepEqual(result.tasks.map((task) => task.state), ["INPUT_REQUIRED"]);
  assert.ok(result.itemId, "the flagged email is in the inbox");

  const decided = await call(chen, `/api/inbox/${result.itemId}/decision`, { decision: "approved", note: "Fine as a reviewed exception." });
  assert.equal(decided.status, 200, JSON.stringify(decided.json));
  const task = await getTask(rivera, result.tasks[0].id);
  assert.equal(task.status?.state, TaskState.TASK_STATE_COMPLETED);
  assert.deepEqual(task.status?.message?.metadata, { itemId: result.itemId, decision: "approved" });

  // The task is the caller's own: another rep of the same company cannot read it.
  await assert.rejects(getTask(nair, result.tasks[0].id));
});

test("a flagged draft is revised once with the approved wording, and still goes to a reviewer", async () => {
  Object.assign(script, { hand_off: { skill: "check-email", text_to_check: "", label_query: "CardioNex starting dose" }, draft_email: { sentences: [PARAPHRASE] }, suggest_claims: { suggestions: [{ sentence: 1, claim_id: "C-02" }] } });
  exporter.reset();
  const result = await handOff(rivera, "Draft an email with the US starting dose of CardioNex, and have it fact-checked.");
  assert.deepEqual(result.tasks.map((task) => task.state), ["INPUT_REQUIRED", "COMPLETED"]);
  assert.equal(result.tasks[0].id, result.tasks[1].id, "the revision is a second turn of the same task");
  assert.match(result.report, /\[approved-claims, C-02\]/);
  assert.match(result.report, /REVIEW_REQUIRED: an agent drafted this email/);
  assert.doesNotMatch(result.report, /UNAPPROVED_CLAIM/);
  assert.ok(!result.report.includes(PARAPHRASE), "the final report never quotes the first draft");
  assert.ok(result.itemId?.startsWith("email-"), "the clean draft still waits for a medical reviewer");

  // Both agents' spans are in one trace, and the fact-checker's are in the hand-off's session.
  await processor.forceFlush();
  const spans = exporter.getFinishedSpans();
  const handoffSpan = spans.find((span) => span.name === "hcp-handoff");
  const checks = spans.filter((span) => span.name === "hcp-fact-check");
  assert.ok(handoffSpan, "the hand-off was traced");
  assert.equal(checks.length, 2, "one fact-check span per turn");
  for (const span of checks) {
    assert.equal(span.spanContext().traceId, handoffSpan.spanContext().traceId, "the fact-check joined the caller's trace");
    assert.equal(span.attributes["session.id"] ?? span.attributes["langfuse.session.id"], result.contextId);
  }
});

test("another company's rep gets nothing from this company's claims: the task is rejected", async () => {
  Object.assign(script, { hand_off: { skill: "check-email", text_to_check: C02, label_query: "" } });
  const result = await handOff(okafor, `Fact-check this sentence: ${C02}`);
  assert.deepEqual(result.tasks.map((task) => task.state), ["REJECTED"]);
  assert.match(result.report, /INSUFFICIENT_CONTEXT/);
  assert.doesNotMatch(result.report, /C-02/);
  assert.equal(result.itemId, null);
});

test("a request no agent's card covers is not handed to anyone", async () => {
  Object.assign(script, { hand_off: { skill: "none", text_to_check: "", label_query: "" } });
  const result = await handOff(rivera, "Book me a flight to Berlin.");
  assert.equal(result.agent, null);
  assert.deepEqual(result.tasks, []);
  assert.match(result.report, /INSUFFICIENT_CONTEXT/);
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

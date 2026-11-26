import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { ClientFactory } from "@a2a-js/sdk/client";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type OpenAI from "openai";
import { createTestStore } from "../../../scripts/fga-model";
import { createApp } from "../app";
import { createAuth } from "../auth";
import { createFactChecker } from "../content/fact-check";
import { createOutreachPlanner } from "../content/outreach";
import { createPool, migrate } from "../db";
import type pg from "pg";
import { connectLabelIndex } from "../rag/search";
import { env } from "../env";
import { InlineQueue, MemoryEventStore } from "../events/store";
import { ReviewStore } from "../reviews";
import { testSweep } from "../test-desk";
import { a2aPath, cardPath } from "./cards";
import { createHandoffAgent } from "./handoff";
import { createTaskStore, TaskReviews } from "./tasks";

// Lesson 15. The whole app on a free port, for a2a.test.ts and a2a.live.ts: the two agents as A2A
// servers and the agent that hands work to them, the SDK's own client, tokens signed by a test
// Keycloak key, a real Postgres for the tasks and the inbox, and a real OpenFGA store made for the
// run. The model factory is the only thing a test chooses: the real one, or one that must not run.

export const ISSUER = "https://keycloak.test/realms/medinfo";

export const C02 = "Start CardioNex at 20mg once daily in adults with HFrEF.";

export type Handoff = { contextId: string; agent: string | null; tasks: Array<{ id: string; state: string }>; itemId: string | null; report: string };

// labels: the live hand-offs search the label index (lesson 20), as the server does at start. The
// code-only tests refuse before any search, and CI has no index, so they leave it out.
export async function startA2aApp(model: () => OpenAI, options: { labels?: boolean } = {}) {
  if (!env.testDatabaseUrl) throw new Error("TEST_DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
  if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

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
  const people = {
    rivera: person("kc-rivera", "pharma_a", ["sales-rep"]),
    nair: person("kc-nair", "pharma_a", ["sales-rep"]),
    chen: person("kc-chen", "pharma_a", ["medical-reviewer"]),
    okafor: person("kc-okafor", "pharma_b", ["sales-rep"])
  };
  const token = (claims: JWTPayload) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "kc-1" }).setIssuer(ISSUER).setAudience("medinfo-api").setIssuedAt().setExpirationTime("5m").sign(privateKey);

  const pool = createPool(env.testDatabaseUrl);
  await migrate(pool);
  let labels: pg.Pool | undefined;
  if (options.labels) {
    if (!env.databaseUrl) throw new Error("DATABASE_URL is not set. Run npm run identity:setup (lesson 11).");
    labels = createPool(env.databaseUrl);
    await connectLabelIndex(labels);
  }
  const store = await createTestStore(env.fgaApiUrl, env.fgaApiToken);
  env.fgaStoreId = store.storeId;
  env.fgaModelId = store.modelId;

  // The agent card names the app's own address, so the server listens before the app is made.
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
    factChecker: createFactChecker({ model }),
    outreachPlanner: createOutreachPlanner({ model }),
    reviews: new ReviewStore(pool),
    recordDecision: async () => {},
    a2a: { store: tasks, links: new TaskReviews(pool, tasks), handoff: createHandoffAgent({ model }) },
    events: { store: new MemoryEventStore(), queue: new InlineQueue(), secrets: {} },
    sweep: testSweep(),
    insights: {} as never
  };
  server.on("request", createApp(auth, desk));

  async function call(claims: JWTPayload, path: string, body?: unknown) {
    const response = await fetch(base + path, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${await token(claims)}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined
    });
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  return {
    base,
    people,
    call,
    async handOff(claims: JWTPayload, query: string) {
      const { status, json } = await call(claims, "/api/handoffs", { query });
      assert.equal(status, 200, JSON.stringify(json));
      return json as unknown as Handoff;
    },
    async getTask(claims: JWTPayload, id: string) {
      const card = await (await fetch(base + cardPath("fact-checker"))).json();
      const client = await new ClientFactory().createFromAgentCard(card);
      return client.getTask({ tenant: "", id, historyLength: 0 }, { serviceParameters: { Authorization: `Bearer ${await token(claims)}` } });
    },
    rpc: (body: unknown, headers: Record<string, string> = {}) =>
      fetch(base + a2aPath("fact-checker"), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    token,
    async close() {
      server.close();
      const owners = Object.values(people).map((claims) => claims.sub);
      await pool.query("DELETE FROM a2a_task_reviews WHERE owner = ANY($1)", [owners]);
      await pool.query("DELETE FROM review_items WHERE thread_id IN (SELECT thread_id FROM threads WHERE owner_id = ANY($1))", [owners]);
      await pool.query("DELETE FROM threads WHERE owner_id = ANY($1)", [owners]);
      await pool.query("DELETE FROM a2a_tasks WHERE owner LIKE $1", [`%-${run}`]);
      await pool.end();
      await labels?.end();
      await store.client.deleteStore();
    }
  };
}

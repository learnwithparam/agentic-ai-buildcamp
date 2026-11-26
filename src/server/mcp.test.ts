import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import { createTestStore } from "../../scripts/fga-model";
import { MCP_CALLBACK_PORT, MCP_CLIENT_ID } from "../../scripts/identity-setup";
import { createApp } from "./app";
import { testDesk } from "./test-desk";
import { createAuth } from "./auth";
import { env } from "./env";
import { createMcpRouter, MCP_PATH, MCP_PUBLIC_ROUTES, METADATA_PATH } from "./mcp";
import type { SessionStore } from "./sessions";
import { useLabelSearch, wordSearch } from "./tools";

// Lesson 12. The MCP door, called the way Claude Code calls it: the SDK's own client over
// streamable HTTP with a Bearer token. The test signs its tokens with a key it made and hands the
// app that key as Keycloak's. search_labels asks a real OpenFGA server, in a store made for the test.

if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");

const ISSUER = "https://keycloak.test/realms/medinfo";
const APP = "http://127.0.0.1:3333";
const { privateKey, publicKey } = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "kc-1", alg: "RS256", use: "sig" };

// MCP never reads a session: it takes tokens only. Any session call fails the test.
const noSessions = new Proxy({} as SessionStore, {
  get: () => () => {
    throw new Error("The MCP door read a browser session.");
  }
});
const auth = createAuth({
  issuer: ISSUER,
  audience: "medinfo-api",
  clientId: "medinfo-chat",
  clientSecret: "test-client-secret",
  appUrl: APP,
  sessions: noSessions,
  keys: createLocalJWKSet({ keys: [jwk] }),
  client: async () => {
    throw new Error("not used");
  }
});

const rivera = { sub: "kc-rivera", name: "Ana Rivera", email: "ana.rivera@pharma-a.example.com", organization: ["pharma_a"], country: "US", azp: "medinfo-mcp" };
const okafor = { sub: "kc-okafor", name: "Chidi Okafor", email: "chidi.okafor@pharma-b.example.com", organization: ["pharma_b"], country: "US", azp: "medinfo-mcp" };

const token = (claims: JWTPayload, audience = "medinfo-api") =>
  new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "kc-1" }).setIssuer(ISSUER).setAudience(audience).setIssuedAt().setExpirationTime("5m").sign(privateKey);

let base = "";
let close = () => {};
let dropStore = async () => {};
before(async () => {
  // The app reads its store from env when it first checks a permission, so point it at the test store.
  const store = await createTestStore(env.fgaApiUrl, env.fgaApiToken);
  env.fgaStoreId = store.storeId;
  env.fgaModelId = store.modelId;
  dropStore = async () => void (await store.client.deleteStore());
  // This file tests who may read what over MCP, not the search, so it searches by words, with no index.
  useLabelSearch(wordSearch);
  const server = createApp(auth, testDesk()).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(async () => {
  close();
  await dropStore();
});

async function connect(claims: JWTPayload) {
  const client = new Client({ name: "mcp-test", version: "1.0.0" });
  const headers = { Authorization: `Bearer ${await token(claims)}` };
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_PATH, base), { requestInit: { headers } }));
  return client;
}

async function search(claims: JWTPayload, query: string) {
  const client = await connect(claims);
  try {
    const result = await client.callTool({ name: "search_labels", arguments: { query } });
    const [content] = result.content as { type: string; text: string }[];
    return (JSON.parse(content.text) as { results: { doc_id: string }[] }).results.map((hit) => hit.doc_id);
  } finally {
    await client.close();
  }
}

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
const listRoutes = (router: { stack: unknown[] }) =>
  (router.stack as Layer[]).flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []
  );

const initialize = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "probe", version: "1" } }
});
const mcpHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };

test("every MCP route but the metadata refuses a request with no token, and says where to sign in", async () => {
  const routes = listRoutes(createMcpRouter(auth));
  const guarded = routes.filter((route) => !MCP_PUBLIC_ROUTES.includes(route));
  assert.deepEqual(guarded.sort(), [`DELETE ${MCP_PATH}`, `GET ${MCP_PATH}`, `POST ${MCP_PATH}`]);
  for (const route of guarded) {
    const [method, path] = route.split(" ");
    const response = await fetch(base + path, { method, headers: mcpHeaders, body: method === "POST" ? initialize : undefined });
    assert.equal(response.status, 401, `${route} answered without a token`);
    assert.match(response.headers.get("www-authenticate") ?? "", new RegExp(`resource_metadata="${APP}${METADATA_PATH}"`));
  }
});

test("a browser session cookie is not a way in", async () => {
  const response = await fetch(base + MCP_PATH, { method: "POST", headers: { ...mcpHeaders, Cookie: `${auth.cookieName}=anything` }, body: initialize });
  assert.equal(response.status, 401);
});

test("a token minted for another app is refused", async () => {
  const response = await fetch(base + MCP_PATH, {
    method: "POST",
    headers: { ...mcpHeaders, Authorization: `Bearer ${await token(okafor, "some-other-api")}` },
    body: initialize
  });
  assert.equal(response.status, 401);
});

test("a page on another site cannot call the tools, even with a token", async () => {
  const response = await fetch(base + MCP_PATH, {
    method: "POST",
    headers: { ...mcpHeaders, Origin: "https://evil.example.com", Authorization: `Bearer ${await token(okafor)}` },
    body: initialize
  });
  assert.equal(response.status, 403);
});

test("the metadata names this server and Keycloak as the place to sign in", async () => {
  const response = await fetch(base + METADATA_PATH);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.resource, `${APP}${MCP_PATH}`);
  assert.deepEqual(body.authorization_servers, [ISSUER]);
});

test("a signed-in client sees the read-only label tools", async () => {
  const client = await connect(okafor);
  const { tools } = await client.listTools();
  await client.close();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["approval_status", "check_interaction", "find_label_text", "label_versions", "read_section", "search_labels", "trial_results"]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));
});

test("the desk facts come from the token, as the server's instructions", async () => {
  const client = await connect(okafor);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  assert.match(instructions, /Pharma B: NeuroVex\. The asker is in US\./);
  assert.doesNotMatch(instructions, /cardionex|pharma a/i);
});

test("a Pharma B doctor searching for Pharma A's medicine over MCP gets none of Pharma A's documents", async () => {
  const asOkafor = await search(okafor, "CardioNex dose");
  assert.ok(asOkafor.every((docId) => !docId.startsWith("cardionex-")), `Pharma B read ${asOkafor.join(", ")}`);
  // The same question from Pharma A finds them, so the empty answer above is the permission, not the search.
  const asRivera = await search(rivera, "CardioNex dose");
  assert.ok(asRivera.some((docId) => docId.startsWith("cardionex-")), "Pharma A found no CardioNex document");
});

test(".mcp.json points Claude Code at this door with the Keycloak client identity:setup creates", () => {
  const config = JSON.parse(readFileSync(new URL("../../.mcp.json", import.meta.url), "utf8"));
  const medinfo = config.mcpServers.medinfo;
  assert.equal(medinfo.type, "http");
  assert.equal(medinfo.url, `${APP}${MCP_PATH}`);
  assert.deepEqual(medinfo.oauth, { clientId: MCP_CLIENT_ID, callbackPort: MCP_CALLBACK_PORT });
});

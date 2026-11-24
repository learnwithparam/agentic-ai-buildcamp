import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import * as oidc from "openid-client";
import { createApp } from "./app";
import { createAuth, PUBLIC_ROUTES } from "./auth";
import { createRoutes } from "./routes";
import { hashId, newId, type PendingLogin, type Session, type SessionStore } from "./sessions";

// Lesson 11. No Keycloak and no model calls: the test signs its own tokens with a key it made,
// and hands the app that key as "Keycloak's". Every check below is the code the server runs.

const ISSUER = "https://keycloak.test/realms/medinfo";
const APP = "http://127.0.0.1:3333";

// Test-only: the same SessionStore contract as PostgresSessionStore (src/server/sessions.test.ts
// runs that one against a real database).
class TestSessionStore implements SessionStore {
  sessions = new Map<string, Session>();
  pending = new Map<string, PendingLogin>();
  async create(session: Session) {
    const id = newId();
    this.sessions.set(hashId(id), session);
    return id;
  }
  async get(id: string) {
    const session = this.sessions.get(hashId(id));
    return session && session.expiresAt > new Date() ? session : null;
  }
  async updateTokens(id: string, tokens: Partial<Session>) {
    const session = this.sessions.get(hashId(id));
    if (session) this.sessions.set(hashId(id), { ...session, ...tokens });
  }
  async delete(id: string) {
    this.sessions.delete(hashId(id));
  }
  async createPending(login: PendingLogin) {
    const id = newId();
    this.pending.set(hashId(id), login);
    return id;
  }
  async takePending(id: string) {
    const login = this.pending.get(hashId(id)) ?? null;
    this.pending.delete(hashId(id));
    return login;
  }
}

const { privateKey, publicKey } = await generateKeyPair("RS256");
const attacker = await generateKeyPair("RS256");
const jwk = { ...(await exportJWK(publicKey)), kid: "kc-1", alg: "RS256", use: "sig" };
const store = new TestSessionStore();
const client = new oidc.Configuration(
  {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/protocol/openid-connect/auth`,
    token_endpoint: `${ISSUER}/protocol/openid-connect/token`,
    end_session_endpoint: `${ISSUER}/protocol/openid-connect/logout`,
    jwks_uri: `${ISSUER}/protocol/openid-connect/certs`
  },
  "medinfo-chat",
  "test-client-secret"
);
const auth = createAuth({
  issuer: ISSUER,
  audience: "medinfo-api",
  clientId: "medinfo-chat",
  clientSecret: "test-client-secret",
  appUrl: APP,
  sessions: store,
  keys: createLocalJWKSet({ keys: [jwk] }),
  client: async () => client
});

const rivera = { sub: "kc-rivera", name: "Ana Rivera", email: "ana.rivera@pharma-a.example.com", organization: ["pharma_a"], country: "US" };
const okafor = { sub: "kc-okafor", name: "Chidi Okafor", email: "chidi.okafor@pharma-b.example.com", organization: ["pharma_b"], country: "US" };

function token(claims: JWTPayload, options: { key?: CryptoKey; audience?: string; issuer?: string; expires?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: "kc-1" })
    .setIssuer(options.issuer ?? ISSUER)
    .setAudience(options.audience ?? "medinfo-api")
    .setIssuedAt()
    .setExpirationTime(options.expires ?? "5m")
    .sign(options.key ?? privateKey);
}

async function sessionFor(claims: JWTPayload, accessToken?: string) {
  return store.create({
    userId: String(claims.sub),
    accessToken: accessToken ?? (await token(claims)),
    refreshToken: null,
    idToken: "id-token-of-" + String(claims.sub),
    accessExpiresAt: new Date(Date.now() + 300_000),
    expiresAt: new Date(Date.now() + 3_600_000)
  });
}

type Layer = { route?: { path: string; methods: Record<string, boolean> } };
const listRoutes = (router: { stack: unknown[] }) =>
  (router.stack as Layer[]).flatMap((layer) =>
    layer.route ? Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${layer.route!.path}`) : []
  );

let base = "";
let close = () => {};
before(async () => {
  const server = createApp(auth).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => server.close();
});
after(() => close());

const asCookie = (sessionId: string) => ({ Cookie: `${auth.cookieName}=${sessionId}`, Origin: APP });
const asBearer = (value: string) => ({ Authorization: `Bearer ${value}` });
const me = (headers: Record<string, string>) => fetch(`${base}/api/me`, { headers });

test("only sign-in, the callback and sign-out are open without signing in", () => {
  assert.deepEqual(listRoutes(auth.router).sort(), [...PUBLIC_ROUTES].sort());
});

test("every other route refuses a request that is not signed in", async () => {
  const guarded = listRoutes(createRoutes(auth));
  assert.ok(guarded.length >= 4, `expected the thread routes, found ${guarded.join(", ")}`);
  for (const route of guarded) {
    const [method, path] = route.split(" ");
    const response = await fetch(base + path.replace(":threadId", crypto.randomUUID()), {
      method,
      headers: { "Content-Type": "application/json", Origin: APP },
      body: method === "GET" ? undefined : JSON.stringify({ messages: [{ id: "q", type: "human", content: "Hello" }] })
    });
    assert.equal(response.status, 401, `${route} answered without a sign-in`);
  }
});

test("a token Keycloak did not sign for this app is the same as no token", async () => {
  const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify({ ...okafor, iss: ISSUER, aud: "medinfo-api", exp: 9_999_999_999 })).toString("base64url");
  const [h, , s] = (await token(rivera)).split(".");
  const rejected = {
    "signed by another key": await token(okafor, { key: attacker.privateKey }),
    unsigned: `${header}.${body}.`,
    "claims swapped under a real signature": `${h}.${body}.${s}`,
    "minted for another app": await token(rivera, { audience: "billing-api" }),
    "from another realm": await token(rivera, { issuer: "https://keycloak.test/realms/other" }),
    expired: await token(rivera, { expires: "-1m" })
  };
  for (const [name, value] of Object.entries(rejected)) {
    assert.equal((await me(asBearer(value))).status, 401, `${name} was accepted`);
  }
});

test("the company and country come from the token, nowhere else", async () => {
  const response = await me(asBearer(await token(okafor)));
  assert.equal(response.status, 200);
  const body = (await response.json()) as { user: unknown; company: unknown };
  assert.deepEqual(body.company, { name: "Pharma B", medicines: ["NeuroVex"] });
  assert.deepEqual(body.user, {
    userId: "kc-okafor",
    name: "Chidi Okafor",
    email: "chidi.okafor@pharma-b.example.com",
    tenantId: "pharma_b",
    country: "US"
  });
  // Keycloak's other claim shape, with organization attributes on, reads the same.
  const attributes = await me(asBearer(await token({ ...rivera, organization: { pharma_a: { id: "org-1" } } })));
  assert.equal(((await attributes.json()) as { user: { tenantId: string } }).user.tenantId, "pharma_a");
});

test("a signed-in doctor with no single known company or no country is refused", async () => {
  const cases = {
    "no company": { ...rivera, organization: [] },
    "two companies": { ...rivera, organization: ["pharma_a", "pharma_b"] },
    "a company this desk does not serve": { ...rivera, organization: ["pharma_z"] },
    "no country": { ...rivera, country: undefined },
    "a country that is not a code": { ...rivera, country: "United States" }
  };
  for (const [name, claims] of Object.entries(cases)) {
    assert.equal((await me(asBearer(await token(claims)))).status, 403, `${name} was let in`);
  }
});

test("the browser session holds the token on the server, and an expired one with no refresh ends", async () => {
  const signedIn = await sessionFor(rivera);
  assert.equal((await me(asCookie(signedIn))).status, 200);
  assert.ok(![...store.sessions.keys()].includes(signedIn), "the store keeps the raw session id");

  const stale = await sessionFor(rivera, await token(rivera, { expires: "-1m" }));
  await store.updateTokens(stale, { accessExpiresAt: new Date(Date.now() - 60_000) });
  assert.equal((await me(asCookie(stale))).status, 401);
  assert.equal(await store.get(stale), null, "the stale session was not removed");
});

test("another doctor's thread does not exist for you", async () => {
  const [owner, other] = await Promise.all([sessionFor(rivera), sessionFor(okafor)]);
  const created = await fetch(`${base}/api/threads`, { method: "POST", headers: asCookie(owner) });
  const { thread_id } = (await created.json()) as { thread_id: string };
  assert.equal((await fetch(`${base}/api/threads/${thread_id}/state`, { headers: asCookie(other) })).status, 404);
  const run = await fetch(`${base}/api/threads/${thread_id}/runs/stream`, {
    method: "POST",
    headers: { ...asCookie(other), "Content-Type": "application/json" },
    body: JSON.stringify({ messages: [{ id: "q", type: "human", content: "Hello" }] })
  });
  assert.equal(run.status, 404);
  assert.equal((await fetch(`${base}/api/threads/${thread_id}/state`, { headers: asCookie(owner) })).status, 200);
});

test("a change sent from another site's page is refused, even with the cookie", async () => {
  const signedIn = await sessionFor(rivera);
  const from = (origin?: string) =>
    fetch(`${base}/api/threads`, { method: "POST", headers: { Cookie: `${auth.cookieName}=${signedIn}`, ...(origin ? { Origin: origin } : {}) } });
  assert.equal((await from("https://evil.example")).status, 403);
  assert.equal((await from()).status, 403);
  assert.equal((await from(APP)).status, 200);
});

test("sign-in sends the doctor to Keycloak with PKCE and remembers the attempt on the server", async () => {
  const response = await fetch(`${base}/api/auth/sign-in?returnTo=//evil.example`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const to = new URL(response.headers.get("location")!);
  assert.equal(`${to.origin}${to.pathname}`, `${ISSUER}/protocol/openid-connect/auth`);
  assert.equal(to.searchParams.get("code_challenge_method"), "S256");
  assert.equal(to.searchParams.get("redirect_uri"), `${APP}/api/auth/callback`);
  assert.deepEqual(to.searchParams.get("scope")!.split(" ").sort(), ["email", "openid", "organization", "profile"]);
  assert.ok(to.searchParams.get("state") && to.searchParams.get("nonce"));
  const cookie = response.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const pending = [...store.pending.values()].at(-1)!;
  assert.equal(pending.state, to.searchParams.get("state"));
  assert.equal(pending.returnTo, "/", "an off-site returnTo was kept");
});

test("a callback with no sign-in attempt, or the wrong state, makes no session", async () => {
  const before = store.sessions.size;
  const none = await fetch(`${base}/api/auth/callback?code=x&state=y`, { redirect: "manual" });
  assert.equal(none.status, 400);
  const started = await fetch(`${base}/api/auth/sign-in`, { redirect: "manual" });
  const loginCookie = started.headers.get("set-cookie")!.split(";")[0];
  const forged = await fetch(`${base}/api/auth/callback?code=x&state=not-the-one-we-sent&iss=${encodeURIComponent(ISSUER)}`, {
    headers: { Cookie: loginCookie },
    redirect: "manual"
  });
  assert.equal(forged.status, 400);
  // The attempt was used up: replaying the same cookie finds nothing.
  const replay = await fetch(`${base}/api/auth/callback?code=x&state=y`, { headers: { Cookie: loginCookie }, redirect: "manual" });
  assert.equal(replay.status, 400);
  assert.equal(store.sessions.size, before);
});

test("sign-out ends the session here and hands back Keycloak's sign-out address", async () => {
  const signedIn = await sessionFor(rivera);
  const response = await fetch(`${base}/api/auth/sign-out`, { method: "POST", headers: asCookie(signedIn) });
  assert.equal(response.status, 200);
  const { redirectTo } = (await response.json()) as { redirectTo: string };
  const to = new URL(redirectTo);
  assert.equal(`${to.origin}${to.pathname}`, `${ISSUER}/protocol/openid-connect/logout`);
  assert.equal(to.searchParams.get("id_token_hint"), "id-token-of-kc-rivera");
  assert.equal(to.searchParams.get("post_logout_redirect_uri"), `${APP}/`);
  assert.equal(await store.get(signedIn), null);
  assert.equal((await me(asCookie(signedIn))).status, 401);
});

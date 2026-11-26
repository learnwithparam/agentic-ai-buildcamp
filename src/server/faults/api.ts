import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from "jose";
import type { AddressInfo } from "node:net";
import { createApp } from "../app";
import { createAuth } from "../auth";
import { useFgaClient } from "../permissions";
import type { Desk } from "../routes";
import type { SessionStore } from "../sessions";
import { testDesk } from "../test-desk";
import { deadOpenFga } from "./inject";
import { operatorDetail } from "./score";

// The two outages the API meets that the agent's tools do not: OpenFGA and Keycloak not answering.
// probeApi starts the real app (the real routes, the real sign-in check, the real agent graph) with
// that one dependency dead, sends one request to each route that needs it, and reports what came
// back. No model is called: every route here fails before it reaches one.
export const API_FAULTS = ["openfga_down", "keycloak_down"] as const;
export type ApiFault = (typeof API_FAULTS)[number];

const ISSUER = "https://keycloak.test/realms/medinfo";
const person = (sub: string, roles: string[]): JWTPayload => ({
  sub,
  name: sub,
  email: `${sub}@example.com`,
  organization: ["pharma_a"],
  country: "US",
  realm_access: { roles: ["default-roles-medinfo", ...roles] }
});

// asked: how many times the route asked the dead OpenFGA, so a probe cannot pass by never reaching it.
export type ApiProbe = { route: string; status: number; body: string; leaks: string[]; asked: number };

// What the people on those routes read, for a route that answers a JSON error or streams a reply.
export async function probeApi(fault: ApiFault): Promise<ApiProbe[]> {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "kc-1", alg: "RS256", use: "sig" };
  const auth = createAuth({
    issuer: ISSUER,
    audience: "medinfo-api",
    clientId: "medinfo-chat",
    clientSecret: "test-client-secret",
    appUrl: "http://127.0.0.1:3333",
    sessions: {} as SessionStore,
    // Keycloak down: its published keys cannot be fetched, which is what jose's remote key set does.
    keys:
      fault === "keycloak_down"
        ? async () => {
            throw new TypeError("fetch failed: connect ECONNREFUSED 127.0.0.1:8180 at node:internal/deps/undici/undici:13502:13");
          }
        : createLocalJWKSet({ keys: [jwk] }),
    client: async () => {
      throw new Error("not used");
    }
  });
  const token = (claims: JWTPayload) =>
    new SignJWT(claims).setProtectedHeader({ alg: "RS256", kid: "kc-1" }).setIssuer(ISSUER).setAudience("medinfo-api").setIssuedAt().setExpirationTime("5m").sign(privateKey);

  // Threads are the only database the chat route touches before the agent runs; a thread store
  // that owns every thread keeps the probe off Postgres.
  const reviews = { createThread: async () => {}, ownsThread: async () => true } as unknown as Desk["reviews"];
  const desk: Desk = { ...testDesk(), reviews };
  const server = createApp(auth, desk).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const dead = deadOpenFga();
  let asked = 0;
  for (const method of ["listObjects", "check"] as const) {
    const original = dead[method].bind(dead) as (...args: unknown[]) => Promise<unknown>;
    (dead as unknown as Record<string, unknown>)[method] = (...args: unknown[]) => (asked++, original(...args));
  }
  if (fault === "openfga_down") useFgaClient(dead);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const doctor = await token(person("kc-rivera", []));
    const rep = await token(person("kc-nair", ["sales-rep"]));
    const analyst = await token(person("kc-okafor", ["analyst"]));
    const ask = (route: string, bearer: string, body?: unknown) =>
      fetch(`${base}${route}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      });
    const calls: Array<[string, () => Promise<Response>]> = [
      ["POST /api/threads/:id/runs/stream", () => ask("/api/threads/t1/runs/stream", doctor, { messages: [{ id: "m1", type: "human", content: "What is the CardioNex starting dose?" }] })],
      ["GET /api/me", () => ask("/api/me", doctor)],
      ["POST /api/insights/threads", () => ask("/api/insights/threads", analyst, {})],
      ["GET /api/hcps", () => ask("/api/hcps", rep)]
    ];
    const probes: ApiProbe[] = [];
    for (const [route, call] of calls) {
      const before = asked;
      const response = await call();
      const body = await response.text();
      probes.push({ route, status: response.status, body, leaks: operatorDetail(body), asked: asked - before });
    }
    return probes;
  } finally {
    useFgaClient(undefined);
    await new Promise((resolve) => server.close(resolve));
  }
}

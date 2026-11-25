import http from "node:http";
import type { AddressInfo } from "node:net";
import { InMemoryTaskStore } from "@a2a-js/sdk/server";
import express from "express";
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from "jose";
import { FactCheckExecutor, OutreachExecutor } from "../src/server/a2a/executors";
import { createHandoffAgent } from "../src/server/a2a/handoff";
import { createA2aRouter } from "../src/server/a2a/server";
import { createAuth } from "../src/server/auth";
import type { FactChecker } from "../src/server/content/fact-check";
import type { OutreachPlanner } from "../src/server/content/outreach";
import type { Identity } from "../src/server/users";

// Lesson 15. The a2a cases go through the real A2A servers and the SDK's client, the way the app
// runs them, on a port of this process. Two things differ from the app, both on purpose:
//   - the tokens are signed by a key made for this run, not by Keycloak, so a run needs no sign-in;
//   - nothing goes to a real inbox and tasks are kept in memory: a script's tasks are thrown away,
//     the same rule lesson 14's runner follows.

const ISSUER = "https://dataset-runner.local/realms/medinfo";

export async function startA2a(agents: { factChecker: FactChecker; outreachPlanner: OutreachPlanner }) {
  const { privateKey, publicKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "runner-1", alg: "RS256", use: "sig" };
  const server = http.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const auth = createAuth({
    issuer: ISSUER,
    audience: "medinfo-api",
    clientId: "dataset-runner",
    clientSecret: "not-used",
    appUrl: base,
    sessions: {} as never,
    keys: createLocalJWKSet({ keys: [jwk] }),
    client: async () => {
      throw new Error("The dataset runner never signs anyone in.");
    }
  });
  const app = express();
  app.use(
    createA2aRouter(auth, {
      store: new InMemoryTaskStore(),
      executors: { "fact-checker": new FactCheckExecutor(agents.factChecker), "outreach-planner": new OutreachExecutor(agents.outreachPlanner) }
    })
  );
  server.on("request", app);
  const handoff = createHandoffAgent();

  // The claims Keycloak would put in the user's access token (lesson 11).
  const tokenFor = (user: Identity) =>
    new SignJWT({ organization: [user.tenantId], country: user.country, realm_access: { roles: user.roles } })
      .setProtectedHeader({ alg: "RS256", kid: "runner-1" })
      .setSubject(user.userId)
      .setIssuer(ISSUER)
      .setAudience("medinfo-api")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);

  return {
    handOff: async (query: string, user: Identity) => (await handoff({ query, user, token: await tokenFor(user), baseUrl: base })).report,
    close: () => new Promise<void>((resolve) => server.close(() => resolve()))
  };
}

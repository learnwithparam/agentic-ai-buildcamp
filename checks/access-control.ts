// Module 07: who may see what.
import { DOCUMENTS, stateOf } from "../data/catalog/documents";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { PEOPLE, personNamed } from "../data/catalog/people";
import {
  applyWalls,
  can,
  demoPassword,
  personFromCookie,
  reportAs,
  signIn,
} from "../packages/core/src/access";
import { rows } from "../packages/core/src/db";
import { activeDocuments, ingestAll, resetDocuments } from "../packages/core/src/ingestion";
import { serve } from "../packages/core/src/surfaces";
import { type Agent, askTeam, type Models } from "../packages/core/src/team";
import { type Check, expect } from "../src/verify";

const SALES_BY_TERRITORY = `SELECT territory, SUM(new_prescriptions) AS total
  FROM pharma_a.territory_rx_weekly
  WHERE brand = 'OncoX' AND week_start BETWEEN '2026-07-01' AND '2026-09-30'
  GROUP BY territory ORDER BY total DESC LIMIT 1`;

type Spy = { models: Models; calls: () => number };

function spyModels(): Spy {
  let count = 0;
  const generate = async () => {
    count += 1;
    return "NOT_IN_DOCUMENTS";
  };
  const writeQuery = async () => {
    count += 1;
    return SALES_BY_TERRITORY;
  };
  return { models: { generate, writeQuery }, calls: () => count };
}

function golden(name: string) {
  const found = HCP_GOLDEN.cases.find((item) => item.name === name);
  expect(found !== undefined, `The golden set has no case named ${name}.`);
  return found;
}

async function askAs(name: string, spy: Spy) {
  const theCase = golden(name);
  return askTeam(theCase.question, theCase.persona, spy.models);
}

const FAR_FUTURE = 9999999999;
const WAIT = AbortSignal.timeout.bind(AbortSignal, 10000);

async function login(base: string, person: string): Promise<string> {
  const body = JSON.stringify({ person });
  const reply = await fetch(`${base}/login`, { method: "POST", body, signal: WAIT() });
  expect(reply.status === 200, `Sign in as ${person} did not work.`);
  return (await reply.json()).token;
}

async function chatStatus(base: string, token: string | undefined, question: string) {
  const headers: Record<string, string> = {};
  if (token !== undefined) headers.authorization = `Bearer ${token}`;
  const body = JSON.stringify({ question, person: "alice" });
  return fetch(`${base}/chat`, { method: "POST", headers, body, signal: WAIT() });
}

export const checks: Check[] = [
  {
    name: "A person from another company is refused before any tool runs",
    tryNext: "In permit, call can() with the brand in the question and refuse when it says no.",
    run: async () => {
      const spy = spyModels();
      const result = await askAs("tenant-wall", spy);
      expect(result.route === "refuse", "A person from another company was not refused.");
      expect(spy.calls() === 0, "A tool or model ran for a refused person.");
      expect(!/\d+ ?mg/.test(result.text), "The refusal leaked a dose.");
    },
  },
  {
    name: "A field rep cannot run a report but a medical affairs person can",
    tryNext: "In canUse, list the tools each role may use. A field rep may only read documents.",
    run: async () => {
      const spy = spyModels();
      const refused = await askAs("role-hides-bi", spy);
      expect(refused.route === "refuse", "A field rep ran a report.");
      expect(spy.calls() === 0, "A tool ran for a field rep.");
      const allowed = await askTeam(golden("top-territory-launch").question, "alice", spy.models);
      expect(allowed.route === "answer", "A medical affairs person could not run a report.");
    },
  },
  {
    name: "Clearance and territory decide which documents a person may read",
    tryNext:
      "In can(), check the tenant, then the clearance, then the territories a field rep covers.",
    run: async () => {
      const carol = personNamed("carol");
      const alice = personNamed("alice");
      const letter = { brand: "CardioZ", type: "safety-letter" } as const;
      expect(!can(carol, letter).allowed, "A low clearance read a safety letter.");
      expect(
        can(alice, letter).allowed,
        "A medical affairs person could not read a safety letter.",
      );
      const mine = can(carol, { brand: "CardioZ", type: "label" });
      expect(mine.allowed, "A field rep could not read a brand her territory carries.");
      const notMine = can(carol, { brand: "OncoX", type: "label" });
      expect(!notMine.allowed, "A field rep read a brand her territories do not carry.");
    },
  },
  {
    name: "The database wall gives every person the same answer as can()",
    tryNext: "Build the policy from the same lists as can(), so the two rules cannot drift.",
    run: async () => {
      await resetDocuments();
      await ingestAll();
      for (const person of PEOPLE) {
        for (const document of DOCUMENTS) {
          if (stateOf(document) !== "current") continue;
          const seen = await activeDocuments(document.brand, document.country, person.name);
          const wanted = can(person, document).allowed;
          const found = seen.some((item) => item.slug === document.slug);
          expect(found === wanted, `${person.name} and ${document.slug} disagree with can().`);
        }
      }
    },
  },
  {
    name: "A refused person gets no document rows from the database",
    tryNext: "In readUnderWall, switch to the reader role and name the person before the query.",
    run: async () => {
      await resetDocuments();
      await ingestAll();
      const bob = await activeDocuments("OncoX", "US", "bob");
      expect(bob.length === 0, "The database gave another company's label to a person.");
      const alice = await activeDocuments("OncoX", "US", "alice");
      expect(alice.length > 0, "The database hid a label from its own company.");
    },
  },
  {
    name: "The doors need a signed token and trust it over the request",
    tryNext: "In personFrom, verify the signed token and use its subject as the person.",
    run: async () => {
      const agent: Agent = (question, person) => askTeam(question, person, spyModels().models);
      const server = serve(agent, 0, true);
      const base = `http://localhost:${server.port}`;
      try {
        const report = golden("role-hides-bi").question;
        const none = await chatStatus(base, undefined, report);
        expect(none.status === 401, "A request with no token got through.");
        const forged = await chatStatus(base, "not.a.token", report);
        expect(forged.status === 401, "A forged token got through.");
        const reply = await chatStatus(base, await login(base, "carol"), report);
        const text = (await reply.text()).split("data: ")[1];
        expect(JSON.parse(text).route === "refuse", "The token did not decide who is asking.");
        const nobody = await fetch(`${base}/login`, {
          method: "POST",
          body: JSON.stringify({ person: "mallory" }),
          signal: WAIT(),
        });
        expect(nobody.status === 404, "An unknown person could sign in.");
      } finally {
        server.stop(true);
      }
    },
  },
  {
    name: "A wrong password is refused and the right one signs in",
    tryNext: "In signIn, check the password with Bun.password.verify before you sign anything.",
    run: async () => {
      const wrong = await signIn("alice", "not-the-password");
      expect(wrong === undefined, "A wrong password signed in.");
      const nobody = await signIn("mallory", demoPassword("alice"));
      expect(nobody === undefined, "An unknown person signed in.");
      const cookie = await signIn("alice", demoPassword("alice"));
      expect(cookie !== undefined, "The right password did not sign in.");
      const person = await personFromCookie(cookie);
      expect(person?.name === "alice", "The session cookie did not name the person.");
    },
  },
  {
    name: "A tampered session cookie is refused",
    tryNext: "In personFromCookie, verify the signature with jwtVerify and trust only its subject.",
    run: async () => {
      const cookie = await signIn("carol", demoPassword("carol"));
      expect(cookie !== undefined, "The right password did not sign in.");
      const [head, body, tail] = cookie.replace("session=", "").split(";")[0].split(".");
      const claims = JSON.stringify({ sub: "alice", exp: FAR_FUTURE });
      const swapped = Buffer.from(claims).toString("base64url");
      const forged = [`session=${head}.${swapped}.${tail}`, `session=${head}.${body}.x${tail}`];
      for (const header of forged) {
        const person = await personFromCookie(header);
        expect(person === undefined, "A changed cookie was accepted.");
      }
      expect((await personFromCookie(null)) === undefined, "A missing cookie gave a person.");
    },
  },
  {
    name: "Postgres refuses a query across companies",
    tryNext: "In reportAs, run SET LOCAL ROLE with the company's own role before the query.",
    run: async () => {
      await applyWalls();
      const own = await reportAs("pharma-a", "SELECT count(*) AS total FROM territory_rx_weekly");
      expect(Number(own[0].total) > 0, "A company could not read its own report data.");
      let refused = false;
      try {
        await reportAs("pharma-a", "SELECT count(*) FROM pharma_b.commercial_dispenses");
      } catch {
        refused = true;
      }
      expect(refused, "Postgres let one company read the other company's schema.");
      const roles = await rows("SELECT rolname FROM pg_roles WHERE rolname LIKE 'tenant_%'");
      expect(roles.length === 2, "There is not one database role for each company.");
    },
  },
];

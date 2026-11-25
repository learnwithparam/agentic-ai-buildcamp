// Lesson 11. Signs each seeded doctor in through the real Keycloak pages, the way a browser
// does, and checks the company and country the app reads from the token. Run it after
// npm run identity:setup with the app running (npm run dev):
//
//   npm run identity:smoke
//   npm run identity:smoke -- --save-state <file> --user ana.rivera@pharma-a.example.com
//   npm run identity:smoke -- --save-state <file> --user maya.chen@pharma-a.example.com   (staff too)
//
// --save-state writes that doctor's signed-in browser cookies as a Playwright storage state
// file (only you can read it), so a browser can open the app already signed in. The password
// is read from .env here and never printed.

import { writeFileSync } from "node:fs";
import { SEED_REVIEWERS, SEED_USERS, TENANTS } from "../src/server/users";
import { APP, sessionHeader, signIn } from "./sign-in";

const argument = (name: string) => {
  const at = process.argv.indexOf(name);
  return at > 0 ? process.argv[at + 1] : undefined;
};
const saveState = argument("--save-state");
const only = argument("--user");

// With no --user it checks every doctor. --user also takes a staff account (a reviewer, a sales rep or
// an analyst), so a presenter can save a signed-in browser for each person in the demo.
const everyone = [...SEED_USERS, ...SEED_REVIEWERS];
const users = only ? everyone.filter((user) => user.email === only) : [...SEED_USERS];
if (!users.length) throw new Error(`No seeded user ${only}. Choose one of: ${everyone.map((user) => user.email).join(", ")}`);

let failed = false;
for (const user of users) {
  try {
    const browser = await signIn(user.email);
    const me = await fetch(`${APP}/api/me`, { signal: AbortSignal.timeout(15_000), headers: { Cookie: sessionHeader(browser) } });
    const body = (await me.json()) as { user?: { tenantId: string; country: string }; company?: { name: string }; error?: string };
    if (!me.ok) throw new Error(`/api/me answered ${me.status}: ${body.error}`);
    if (body.user?.tenantId !== user.tenantId || body.user.country !== user.country) {
      throw new Error(`expected ${user.tenantId} ${user.country}, the app read ${body.user?.tenantId} ${body.user?.country}`);
    }
    console.log(`ok   ${user.email}: signed in as ${TENANTS[user.tenantId].name}, ${user.country}`);
    if (saveState) {
      const cookies = [...browser.cookies.values()].map((cookie) => ({ ...cookie, expires: Math.floor(Date.now() / 1000) + 3600 }));
      writeFileSync(saveState, JSON.stringify({ cookies, origins: [] }), { mode: 0o600 });
      console.log(`     saved the signed-in browser state to ${saveState}`);
    }
  } catch (error) {
    failed = true;
    console.log(`FAIL ${user.email}: ${(error as Error).message}`);
  }
}
process.exitCode = failed ? 1 : 0;

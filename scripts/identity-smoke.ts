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

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";
import { SEED_REVIEWERS, SEED_USERS, TENANTS } from "../src/server/users";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = parse(readFileSync(path.join(root, ".env"), "utf8"));
const APP = (settings.APP_URL || "http://127.0.0.1:3333").replace(/\/$/, "");
const password = settings.SEED_USER_PASSWORD;
if (!password) throw new Error("SEED_USER_PASSWORD is not set. Run npm run identity:setup first.");

type Cookie = { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" };

// A tiny cookie jar: enough for one sign-in across two sites (the app and Keycloak).
class Browser {
  cookies = new Map<string, Cookie>();

  private store(url: URL, response: Response) {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";").map((part) => part.trim());
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const attribute = (key: string) => attributes.find((part) => part.toLowerCase().startsWith(key));
      const key = `${url.hostname} ${name}`;
      if (!value || /max-age=0|expires=thu, 01 jan 1970/i.test(line)) {
        this.cookies.delete(key);
        continue;
      }
      const sameSite = attribute("samesite=")?.split("=")[1]?.toLowerCase();
      this.cookies.set(key, {
        name,
        value,
        domain: url.hostname,
        path: attribute("path=")?.split("=")[1] ?? "/",
        httpOnly: Boolean(attribute("httponly")),
        secure: Boolean(attribute("secure")),
        sameSite: sameSite === "strict" ? "Strict" : sameSite === "none" ? "None" : "Lax"
      });
    }
  }

  // Follows redirects by hand, so each hop's cookies are kept and sent to the right site.
  async go(start: string, init: RequestInit = {}): Promise<{ url: URL; response: Response }> {
    let url = new URL(start);
    let request = init;
    for (let hop = 0; hop < 10; hop += 1) {
      const cookie = [...this.cookies.values()]
        .filter((item) => item.domain === url.hostname && url.pathname.startsWith(item.path))
        .map((item) => `${item.name}=${item.value}`)
        .join("; ");
      const response = await fetch(url, { ...request, signal: AbortSignal.timeout(15_000), redirect: "manual", headers: { ...request.headers, ...(cookie ? { Cookie: cookie } : {}) } });
      this.store(url, response);
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location) return { url, response };
      url = new URL(location, url);
      request = {};
    }
    throw new Error(`Too many redirects from ${start}`);
  }
}

const decode = (value: string) => value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'");

// Keycloak's login can take one page (username and password) or two (username first, which is
// how organizations find the account's company). Fill whatever the page asks for until it
// sends the browser back to the app.
async function signIn(email: string): Promise<Browser> {
  const browser = new Browser();
  let { url, response } = await browser.go(`${APP}/api/auth/sign-in`);
  for (let page = 0; page < 3 && url.origin !== new URL(APP).origin; page += 1) {
    const html = await response.text();
    const form = html.match(/<form[^>]*id="kc-(?:form-login|login-form|username-form)"[^>]*action="([^"]+)"/) ?? html.match(/<form[^>]*action="([^"]+)"/);
    if (!form) throw new Error(`Keycloak showed no sign-in form at ${url.pathname}`);
    const fields = new URLSearchParams();
    if (/name="username"/.test(html)) fields.set("username", email);
    if (/name="password"/.test(html)) fields.set("password", password);
    if (/name="credentialId"/.test(html)) fields.set("credentialId", "");
    if (![...fields.keys()].length) throw new Error(`Keycloak asked for something other than a username or password at ${url.pathname}`);
    ({ url, response } = await browser.go(decode(form[1]), {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: fields.toString()
    }));
  }
  if (url.origin !== new URL(APP).origin) throw new Error(`${email}: Keycloak did not send the browser back to the app`);
  if (!response.ok) throw new Error(`${email}: the app refused the sign-in (${response.status}): ${(await response.text()).slice(0, 200)}`);
  return browser;
}

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
    const session = [...browser.cookies.values()].find((cookie) => cookie.domain === new URL(APP).hostname && cookie.name.endsWith("medinfo_session"));
    if (!session) throw new Error("no session cookie after the callback");
    const me = await fetch(`${APP}/api/me`, { signal: AbortSignal.timeout(15_000), headers: { Cookie: `${session.name}=${session.value}` } });
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

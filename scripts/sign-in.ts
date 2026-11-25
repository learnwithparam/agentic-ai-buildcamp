// Lessons 11 and on. Signs a seeded person in through the real Keycloak pages, the way a browser
// does, and keeps the cookies. Shared by the scripts that act as a signed-in person
// (scripts/identity-smoke.ts, scripts/demo-turns.ts). The password is read from .env and never printed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const settings = parse(readFileSync(path.join(root, ".env"), "utf8"));
export const APP = (settings.APP_URL || "http://127.0.0.1:3333").replace(/\/$/, "");
const password = settings.SEED_USER_PASSWORD;

type Cookie = { name: string; value: string; domain: string; path: string; httpOnly: boolean; secure: boolean; sameSite: "Lax" | "Strict" | "None" };

// A tiny cookie jar: enough for one sign-in across two sites (the app and Keycloak).
export class Browser {
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
export async function signIn(email: string): Promise<Browser> {
  if (!password) throw new Error("SEED_USER_PASSWORD is not set. Run npm run identity:setup first.");
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

// The app's session cookie, as one Cookie header.
export function sessionHeader(browser: Browser): string {
  const session = [...browser.cookies.values()].find((cookie) => cookie.domain === new URL(APP).hostname && cookie.name.endsWith("medinfo_session"));
  if (!session) throw new Error("no session cookie after the callback");
  return `${session.name}=${session.value}`;
}

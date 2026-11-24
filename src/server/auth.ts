import type { NextFunction, Request, RequestHandler, Response } from "express";
import { Router } from "express";
import { createRemoteJWKSet, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from "jose";
import * as oidc from "openid-client";
import type { SessionStore } from "./sessions";
import { TENANTS, type Identity } from "./users";

// Lesson 11. Who is asking comes from Keycloak, never from the request body or the prompt.
//
// - The browser signs in on Keycloak's own page (authorization code flow with PKCE). This server
//   is the only OpenID client: it swaps the code for tokens and keeps them in Postgres. The page
//   gets an HttpOnly session cookie and never sees a token (the "backend for frontend" pattern).
// - Every request is checked by one function, identityOf: it verifies the access token's
//   signature, issuer, audience and expiry against Keycloak's published keys, then reads the
//   doctor's company (their Keycloak organization) and country (an attribute only an admin sets).
// - Other programs (lesson 12's MCP clients) send the same kind of token as a Bearer header and
//   go through the same check.

export type AuthConfig = {
  issuer: string;
  audience: string;
  clientId: string;
  clientSecret: string;
  appUrl: string;
  sessions: SessionStore;
  // Keycloak's signing keys. Production fetches and caches them; tests pass a local key set.
  keys?: JWTVerifyGetKey;
  // The OpenID client configuration. Production discovers it from the issuer; tests build it.
  client?: () => Promise<oidc.Configuration>;
};

export class AuthError extends Error {
  constructor(
    readonly status: 401 | 403,
    message: string
  ) {
    super(message);
  }
}

const SESSION_HOURS = 8;
const PENDING_MINUTES = 10;
const SCOPES = "openid profile email organization";
// Refresh a little early, so a token never expires between this check and the model call.
const REFRESH_EARLY_MS = 30_000;

// The doctor in a verified token, or an error saying which part is missing.
export function identityFromClaims(claims: JWTPayload): Identity {
  // Keycloak's organization mapper sends the aliases as a list, or as an object keyed by alias
  // when organization attributes are switched on. Only companies this desk serves count.
  const raw = claims.organization;
  const aliases = Array.isArray(raw) ? raw.map(String) : raw && typeof raw === "object" ? Object.keys(raw) : [];
  const companies = aliases.filter((alias) => alias in TENANTS);
  if (companies.length !== 1) {
    throw new AuthError(403, "Your account is not a member of exactly one company on this desk.");
  }
  const country = typeof claims.country === "string" ? claims.country : "";
  if (!/^[A-Z]{2}$/.test(country)) throw new AuthError(403, "Your account has no country. Ask your administrator to set it.");
  if (!claims.sub) throw new AuthError(401, "The token has no subject.");
  return {
    userId: claims.sub,
    name: typeof claims.name === "string" ? claims.name : "",
    email: typeof claims.email === "string" ? claims.email : "",
    tenantId: companies[0],
    country
  };
}

function readCookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return decodeURIComponent(part.slice(at + 1).trim());
  }
  return undefined;
}

export function createAuth(config: AuthConfig) {
  const secure = new URL(config.appUrl).protocol === "https:";
  // On https the __Host- prefix makes the browser refuse the cookie from any other path or subdomain.
  const SESSION_COOKIE = secure ? "__Host-medinfo_session" : "medinfo_session";
  const LOGIN_COOKIE = secure ? "__Host-medinfo_login" : "medinfo_login";
  const cookieOptions = { httpOnly: true, sameSite: "lax" as const, secure, path: "/" };

  const keys = config.keys ?? createRemoteJWKSet(new URL(`${config.issuer}/protocol/openid-connect/certs`));

  let discovered: Promise<oidc.Configuration> | undefined;
  const client =
    config.client ??
    (() => {
      // Plain http is allowed only for a Keycloak on this machine, as in the workshop.
      const local = ["localhost", "127.0.0.1"].includes(new URL(config.issuer).hostname);
      discovered ??= oidc
        .discovery(new URL(config.issuer), config.clientId, config.clientSecret, undefined, {
          execute: local ? [oidc.allowInsecureRequests] : []
        })
        .catch((error) => {
          discovered = undefined;
          throw error;
        });
      return discovered;
    });

  async function verify(token: string): Promise<Identity> {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, keys, {
        issuer: config.issuer,
        audience: config.audience,
        algorithms: ["RS256", "ES256", "PS256"]
      }));
    } catch {
      throw new AuthError(401, "Sign in first.");
    }
    return identityFromClaims(payload);
  }

  // One refresh per session at a time, so two tabs do not race to spend the same refresh token.
  const refreshing = new Map<string, Promise<string>>();

  async function freshAccessToken(sessionId: string): Promise<string> {
    const session = await config.sessions.get(sessionId);
    if (!session) throw new AuthError(401, "Sign in first.");
    if (session.accessExpiresAt.getTime() - REFRESH_EARLY_MS > Date.now()) return session.accessToken;
    if (!session.refreshToken) {
      await config.sessions.delete(sessionId);
      throw new AuthError(401, "Your sign-in has expired.");
    }
    const running = refreshing.get(sessionId);
    if (running) return running;
    const refresh = (async () => {
      try {
        const tokens = await oidc.refreshTokenGrant(await client(), session.refreshToken!);
        await config.sessions.updateTokens(sessionId, {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token ?? session.refreshToken,
          idToken: tokens.id_token ?? null,
          accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 60) * 1000)
        });
        return tokens.access_token;
      } catch {
        // Keycloak refused: the account was disabled, signed out elsewhere, or the session ended.
        await config.sessions.delete(sessionId);
        throw new AuthError(401, "Your sign-in has expired.");
      } finally {
        refreshing.delete(sessionId);
      }
    })();
    refreshing.set(sessionId, refresh);
    return refresh;
  }

  // The one resolver: a Bearer token from a program, or the session cookie from the browser.
  async function identityOf(request: Request): Promise<Identity> {
    const header = request.headers.authorization;
    if (header?.startsWith("Bearer ")) return verify(header.slice("Bearer ".length));
    const sessionId = readCookie(request, SESSION_COOKIE);
    if (!sessionId) throw new AuthError(401, "Sign in first.");
    return verify(await freshAccessToken(sessionId));
  }

  const requireUser: RequestHandler = async (request, response, next) => {
    try {
      response.locals.user = await identityOf(request);
      next();
    } catch (error) {
      if (!(error instanceof AuthError)) return next(error);
      response.status(error.status).json({ error: error.message });
    }
  };

  // A cookie is sent on any request to this site, even one a different site's page starts.
  // So every request that changes something must come from our own page.
  const appOrigin = new URL(config.appUrl).origin;
  function sameOrigin(request: Request, response: Response, next: NextFunction) {
    if (["GET", "HEAD", "OPTIONS"].includes(request.method) || request.headers.authorization) return next();
    if (request.headers.origin !== appOrigin) {
      response.status(403).json({ error: "This request did not come from the medinfo page." });
      return;
    }
    next();
  }

  // Where to send the doctor after sign-in: a path on this app, or "/". The value is read the way a
  // browser reads it, so "/\evil.example" (which a browser treats as "//evil.example") is refused.
  function pathOnThisApp(value: unknown): string {
    if (typeof value !== "string" || !value.startsWith("/") || /[\\\u0000-\u001f\u007f]/.test(value)) return "/";
    const url = new URL(value, appOrigin);
    // Check what is returned, not what came in: "/.//evil.example" normalizes to "//evil.example".
    const path = `${url.pathname}${url.search}${url.hash}`;
    return url.origin === appOrigin && !path.startsWith("//") ? path : "/";
  }

  const router = Router();

  router.get("/api/auth/sign-in", async (request, response, next) => {
    try {
      const returnTo = pathOnThisApp(request.query.returnTo);
      const codeVerifier = oidc.randomPKCECodeVerifier();
      const state = oidc.randomState();
      const nonce = oidc.randomNonce();
      const pendingId = await config.sessions.createPending({
        codeVerifier,
        state,
        nonce,
        returnTo,
        expiresAt: new Date(Date.now() + PENDING_MINUTES * 60_000)
      });
      const url = oidc.buildAuthorizationUrl(await client(), {
        redirect_uri: `${config.appUrl}/api/auth/callback`,
        scope: SCOPES,
        code_challenge: await oidc.calculatePKCECodeChallenge(codeVerifier),
        code_challenge_method: "S256",
        state,
        nonce
      });
      response.cookie(LOGIN_COOKIE, pendingId, { ...cookieOptions, maxAge: PENDING_MINUTES * 60_000 });
      response.redirect(302, url.href);
    } catch (error) {
      next(error);
    }
  });

  router.get("/api/auth/callback", async (request, response, next) => {
    const pendingId = readCookie(request, LOGIN_COOKIE);
    response.clearCookie(LOGIN_COOKIE, cookieOptions);
    const pending = pendingId ? await config.sessions.takePending(pendingId).catch(next) : null;
    if (!pending) {
      response.status(400).type("text").send("This sign-in link has expired or was already used. Start again from the sign-in button.");
      return;
    }
    let tokens: oidc.TokenEndpointResponse;
    try {
      tokens = await oidc.authorizationCodeGrant(await client(), new URL(request.originalUrl, config.appUrl), {
        pkceCodeVerifier: pending.codeVerifier,
        expectedState: pending.state,
        expectedNonce: pending.nonce,
        idTokenExpected: true
      });
    } catch {
      response.status(400).type("text").send("Keycloak did not confirm this sign-in. Start again from the sign-in button.");
      return;
    }
    try {
      const user = await verify(tokens.access_token);
      const sessionId = await config.sessions.create({
        userId: user.userId,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? null,
        idToken: tokens.id_token ?? null,
        accessExpiresAt: new Date(Date.now() + (tokens.expires_in ?? 60) * 1000),
        expiresAt: new Date(Date.now() + SESSION_HOURS * 3_600_000)
      });
      response.cookie(SESSION_COOKIE, sessionId, { ...cookieOptions, maxAge: SESSION_HOURS * 3_600_000 });
      response.redirect(302, pending.returnTo);
    } catch (error) {
      if (!(error instanceof AuthError)) return next(error);
      response.status(error.status).type("text").send(error.message);
    }
  });

  // Ends this app's session and returns Keycloak's sign-out address, so the page can end the
  // Keycloak session too. Without that step the next sign-in would skip the password.
  router.post("/api/auth/sign-out", async (request, response, next) => {
    try {
      const sessionId = readCookie(request, SESSION_COOKIE);
      const session = sessionId ? await config.sessions.get(sessionId) : null;
      if (sessionId) await config.sessions.delete(sessionId);
      response.clearCookie(SESSION_COOKIE, cookieOptions);
      const url = oidc.buildEndSessionUrl(await client(), {
        post_logout_redirect_uri: `${config.appUrl}/`,
        ...(session?.idToken ? { id_token_hint: session.idToken } : { client_id: config.clientId })
      });
      response.json({ redirectTo: url.href });
    } catch (error) {
      next(error);
    }
  });

  return { router, requireUser, sameOrigin, identityOf, cookieName: SESSION_COOKIE };
}

export type Auth = ReturnType<typeof createAuth>;

// The routes open without signing in. src/server/auth.test.ts holds the auth router to this list.
export const PUBLIC_ROUTES = ["GET /api/auth/sign-in", "GET /api/auth/callback", "POST /api/auth/sign-out"];

export function currentUser(response: Response): Identity {
  return response.locals.user as Identity;
}

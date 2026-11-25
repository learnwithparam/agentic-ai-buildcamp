import { createServer } from "node:http";
import { Entry } from "@napi-rs/keyring";
import * as oidc from "openid-client";
import { API_METADATA_PATH, SIGN_IN_SCOPES } from "../shared/messages";
import { CLI_CALLBACK_PORT, CLI_CLIENT_ID, CLI_REDIRECT_URI, CliError } from "./config";

// Lesson 19. How the CLI signs a doctor in, and keeps them signed in:
//   - It asks the app where to sign in, then opens Keycloak's own page in the browser. The CLI
//     never sees the password, and the sign-in uses PKCE, so a stolen code is useless.
//   - Keycloak sends the code to a listener on 127.0.0.1 that lives only for this sign-in.
//   - The tokens go to the system keychain (macOS Keychain, Windows Credential Manager, the Secret
//     Service on Linux), never to a file in the home folder.
//   - Each command sends the access token as a Bearer header. The server reads the company and
//     country from it, exactly as for the browser (lesson 11).

export type Tokens = { accessToken: string; refreshToken: string; expiresAt: number };

export type TokenStore = { read(): Tokens | null; write(tokens: Tokens): void; clear(): void };

// One keychain entry per app address, so a doctor signed in to two desks keeps both.
export function keychainStore(appUrl: string): TokenStore {
  const entry = new Entry(CLI_CLIENT_ID, appUrl);
  return {
    read: () => {
      const saved = entry.getPassword();
      return saved ? (JSON.parse(saved) as Tokens) : null;
    },
    write: (tokens) => entry.setPassword(JSON.stringify(tokens)),
    clear: () => void entry.deletePassword()
  };
}

// Where to sign in, read from the app (src/server/auth.ts, RFC 9728), then Keycloak's own
// discovery document. A Keycloak on this machine is plain http; any other must be https.
export async function signInServer(appUrl: string): Promise<oidc.Configuration> {
  let issuer: string | undefined;
  try {
    const response = await fetch(new URL(API_METADATA_PATH, appUrl), { signal: AbortSignal.timeout(10_000) });
    if (response.ok) issuer = ((await response.json()) as { authorization_servers?: string[] }).authorization_servers?.[0];
  } catch {
    // Reported below with the address, which is what the doctor can check.
  }
  if (!issuer) throw new CliError(`${appUrl} did not say where to sign in. Is the app running at that address?`);
  const local = ["localhost", "127.0.0.1"].includes(new URL(issuer).hostname);
  return oidc.discovery(new URL(issuer), CLI_CLIENT_ID, undefined, oidc.None(), { execute: local ? [oidc.allowInsecureRequests] : [] });
}

function tokensFrom(response: oidc.TokenEndpointResponse, keepRefresh?: string): Tokens {
  const refreshToken = response.refresh_token ?? keepRefresh;
  if (!refreshToken) throw new CliError("Keycloak signed you in but gave no refresh token, so the CLI cannot keep you signed in.");
  return { accessToken: response.access_token, refreshToken, expiresAt: Date.now() + (response.expires_in ?? 60) * 1000 };
}

// The listener Keycloak sends the browser back to. It answers only /callback, and only for the
// sign-in it started: a request with another state is refused and the wait goes on.
export function waitForCallback(state: string, port = CLI_CALLBACK_PORT, timeoutMs = 5 * 60_000) {
  let settle: { resolve: (url: URL) => void; reject: (error: Error) => void };
  const result = new Promise<URL>((resolve, reject) => (settle = { resolve, reject }));
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
    const page = (status: number, text: string) => {
      response.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
      response.end(`<!doctype html><title>medinfo CLI</title><p style="font:16px system-ui;margin:3rem">${text}</p>`);
    };
    if (url.pathname !== "/callback") return page(404, "Nothing here.");
    if (url.searchParams.get("state") !== state) return page(400, "This sign-in did not start in your terminal, so it was ignored.");
    const error = url.searchParams.get("error");
    if (error) {
      page(400, "Sign-in did not finish. Go back to the terminal.");
      return settle.reject(new CliError(`Keycloak refused the sign-in: ${url.searchParams.get("error_description") ?? error}.`));
    }
    page(200, "You are signed in. You can close this tab and go back to the terminal.");
    settle.resolve(url);
  });
  const timer = setTimeout(() => settle.reject(new CliError("Sign-in timed out after 5 minutes. Run medinfo login again.")), timeoutMs);
  const ready = new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "EADDRINUSE" ? new CliError(`Port ${port} is in use, so Keycloak cannot reach the CLI. Close the other sign-in first.`) : error)
    );
    server.listen(port, "127.0.0.1", resolve);
  });
  const done = result.finally(() => {
    clearTimeout(timer);
    server.close();
  });
  // The browser can come back before the caller awaits the result; that is not an unhandled error.
  done.catch(() => {});
  return { ready, result: done };
}

// medinfo login: start the sign-in, show the address, wait for the code, keep the tokens.
export async function login(config: oidc.Configuration, store: TokenStore, show: (url: string) => Promise<void>) {
  const verifier = oidc.randomPKCECodeVerifier();
  const state = oidc.randomState();
  const url = oidc.buildAuthorizationUrl(config, {
    redirect_uri: CLI_REDIRECT_URI,
    scope: SIGN_IN_SCOPES,
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
    code_challenge_method: "S256",
    state
  });
  const callback = waitForCallback(state);
  await callback.ready;
  await show(url.href);
  const response = await oidc.authorizationCodeGrant(config, await callback.result, { pkceCodeVerifier: verifier, expectedState: state });
  store.write(tokensFrom(response));
}

export const SIGNED_OUT = "You are not signed in. Run: medinfo login";
export const SESSION_ENDED = "Your sign-in has ended. Run: medinfo login";

// The access token for one command. A token with 30 seconds or more left is used as it is;
// otherwise the refresh token buys a new one. A refresh Keycloak refuses (the session ended or
// was revoked) signs the CLI out; Keycloak being down does not.
export async function accessToken(
  store: TokenStore,
  refresh: (refreshToken: string) => Promise<oidc.TokenEndpointResponse>,
  now = Date.now()
): Promise<string> {
  const saved = store.read();
  if (!saved) throw new CliError(SIGNED_OUT);
  if (saved.expiresAt - 30_000 > now) return saved.accessToken;
  let response: oidc.TokenEndpointResponse;
  try {
    response = await refresh(saved.refreshToken);
  } catch (error) {
    if (error instanceof oidc.ResponseBodyError && error.error === "invalid_grant") {
      store.clear();
      throw new CliError(SESSION_ENDED);
    }
    throw new CliError("Keycloak is not reachable, so the CLI cannot renew your sign-in. Try again in a moment.");
  }
  const tokens = tokensFrom(response, saved.refreshToken);
  store.write(tokens);
  return tokens.accessToken;
}

// medinfo logout: Keycloak ends the session, then the keychain entry goes. If Keycloak cannot be
// reached, the entry still goes, and the doctor is told the session may live until it expires.
export async function logout(config: () => Promise<oidc.Configuration>, store: TokenStore): Promise<"ended" | "local-only" | "not-signed-in"> {
  const saved = store.read();
  if (!saved) return "not-signed-in";
  let ended = true;
  try {
    await oidc.tokenRevocation(await config(), saved.refreshToken, { token_type_hint: "refresh_token" });
  } catch {
    ended = false;
  }
  store.clear();
  return ended ? "ended" : "local-only";
}

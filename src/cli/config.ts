// Lesson 19. What the medinfo CLI needs to know before it signs in: its own Keycloak client, the
// port on this machine where Keycloak sends the sign-in code, and the app's address. Everything
// else (where Keycloak is, which audience) it reads from the app.

// scripts/identity-setup.ts creates this public client with PKCE and this one redirect.
export const CLI_CLIENT_ID = "medinfo-cli";
export const CLI_CALLBACK_PORT = 33419;
export const CLI_REDIRECT_URI = `http://127.0.0.1:${CLI_CALLBACK_PORT}/callback`;

// The chat's address, the same one a doctor opens in the browser.
export const DEFAULT_APP_URL = "http://127.0.0.1:3333";

// A message for the person at the terminal. Anything else that goes wrong is a bug, and the CLI
// says so without the stack trace.
export class CliError extends Error {}

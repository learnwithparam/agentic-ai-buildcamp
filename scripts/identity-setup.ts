// Lesson 11. npm run identity:setup
//
// Starts Postgres, Keycloak and OpenFGA (infra/docker-compose.yml) and configures them, so the app
// signs doctors in through Keycloak and asks OpenFGA what each may read. Safe to run again: each
// step looks first and changes only what differs.
//
// Secrets are generated into .env the first time and never printed. Sign in with a seeded doctor
// using the password in your own .env (SEED_USER_PASSWORD).

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialsMethod, OpenFgaClient } from "@openfga/sdk";
import { parse } from "dotenv";
import { REVIEWER_ROLES, SEED_REVIEWERS, SEED_USERS, TENANTS, type ReviewerRole } from "../src/server/users";
import { modelJson, syncDocumentTuples } from "./fga-model";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, ".env");
const REALM = "medinfo";
const CLIENT_ID = "medinfo-chat";
const AUDIENCE = "medinfo-api";
const KEYCLOAK = "http://localhost:8180";
const FGA = "http://localhost:8280";
const FGA_STORE_NAME = "medinfo";

// ---------- .env: generate what is missing, keep what is there ----------

const secret = () => randomBytes(24).toString("base64url");

function setEnv(values: Record<string, string>) {
  const lines = existsSync(envFile) ? readFileSync(envFile, "utf8").split("\n") : [];
  for (const [name, value] of Object.entries(values)) {
    const at = lines.findIndex((line) => line.startsWith(`${name}=`));
    if (at >= 0) lines[at] = `${name}=${value}`;
    else lines.splice(lines.at(-1) === "" ? lines.length - 1 : lines.length, 0, `${name}=${value}`);
  }
  writeFileSync(envFile, `${lines.join("\n").replace(/\n*$/, "")}\n`, { mode: 0o600 });
}

function ensureSecrets(): Record<string, string> {
  const current = existsSync(envFile) ? parse(readFileSync(envFile)) : {};
  const missing: Record<string, string> = {};
  const want = (name: string, make: () => string) => {
    if (!current[name]) missing[name] = make();
  };
  for (const name of ["POSTGRES_PASSWORD", "KEYCLOAK_DB_PASSWORD", "OPENFGA_DB_PASSWORD", "MEDINFO_DB_PASSWORD"]) want(name, secret);
  for (const name of ["KEYCLOAK_ADMIN_PASSWORD", "FGA_API_TOKEN", "OIDC_CLIENT_SECRET", "SEED_USER_PASSWORD"]) want(name, secret);
  const medinfo = missing.MEDINFO_DB_PASSWORD ?? current.MEDINFO_DB_PASSWORD;
  want("DATABASE_URL", () => `postgresql://medinfo:${medinfo}@localhost:5442/medinfo`);
  want("TEST_DATABASE_URL", () => `postgresql://medinfo:${medinfo}@localhost:5442/medinfo_test`);
  if (Object.keys(missing).length) {
    setEnv(missing);
    console.log(`Generated into .env (values not shown): ${Object.keys(missing).join(", ")}`);
  }
  return { ...current, ...missing };
}

// ---------- Keycloak admin API ----------

let adminToken = "";

async function kc(method: string, route: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${KEYCLOAK}/admin/realms${route}`, {
    method,
    headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  if (!response.ok && response.status !== 404 && response.status !== 409) {
    throw new Error(`Keycloak ${method} ${route} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return response;
}

async function kcJson<T>(route: string): Promise<T | null> {
  const response = await kc("GET", route);
  return response.status === 404 ? null : ((await response.json()) as T);
}

async function signInAsAdmin(password: string) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "password", client_id: "admin-cli", username: "admin", password })
      });
      if (response.ok) {
        adminToken = ((await response.json()) as { access_token: string }).access_token;
        return;
      }
      if (response.status === 401) throw new Error("Keycloak refused the admin password in .env. If you changed it, reset the volume.");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Keycloak refused")) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error("Keycloak did not start within two minutes. Check: docker compose -f infra/docker-compose.yml logs keycloak");
}

async function setupRealm() {
  const settings = {
    realm: REALM,
    displayName: "HCP Medical Information",
    enabled: true,
    // Each company is a Keycloak organization; its alias is the tenant id the app uses.
    organizationsEnabled: true,
    // No one signs themselves up: an administrator creates each doctor's account.
    registrationAllowed: false,
    resetPasswordAllowed: false,
    bruteForceProtected: true,
    failureFactor: 5,
    passwordPolicy: "length(12) and notUsername and notEmail",
    sslRequired: "external",
    // Short access tokens; the app refreshes them, and a disabled account stops within five minutes.
    accessTokenLifespan: 300,
    ssoSessionIdleTimeout: 1800,
    ssoSessionMaxLifespan: 28800
  };
  const existing = await kcJson(`/${REALM}`);
  await kc(existing ? "PUT" : "POST", existing ? `/${REALM}` : "", settings);
  console.log(`Realm ${REALM}: ${existing ? "updated" : "created"}`);
}

type UserProfile = { attributes: { name: string }[] } & Record<string, unknown>;

async function setupCountryAttribute() {
  const profile = (await kcJson<UserProfile>(`/${REALM}/users/profile`))!;
  const country = {
    name: "country",
    displayName: "Country",
    // Only an administrator sets it: the doctor cannot change which country's label they get.
    permissions: { view: ["admin", "user"], edit: ["admin"] },
    validations: { pattern: { pattern: "^[A-Z]{2}$", "error-message": "Use a two-letter country code, such as US." } },
    multivalued: false
  };
  profile.attributes = [...profile.attributes.filter((attribute) => attribute.name !== "country"), country];
  await kc("PUT", `/${REALM}/users/profile`, profile);
}

type Organization = { id: string; alias: string };

async function setupOrganizations(): Promise<Record<string, string>> {
  const ids: Record<string, string> = {};
  for (const [alias, tenant] of Object.entries(TENANTS)) {
    const found = (await kcJson<Organization[]>(`/${REALM}/organizations?search=${encodeURIComponent(tenant.name)}&exact=true`)) ?? [];
    const body = { name: tenant.name, alias, enabled: true, domains: [{ name: tenant.domain, verified: true }] };
    let organization = found.find((item) => item.alias === alias);
    if (organization) await kc("PUT", `/${REALM}/organizations/${organization.id}`, { ...body, id: organization.id });
    else {
      await kc("POST", `/${REALM}/organizations`, body);
      organization = ((await kcJson<Organization[]>(`/${REALM}/organizations?search=${encodeURIComponent(tenant.name)}&exact=true`)) ?? []).find(
        (item) => item.alias === alias
      );
    }
    if (!organization) throw new Error(`Keycloak did not create the organization ${alias}.`);
    ids[alias] = organization.id;
  }
  console.log(`Organizations: ${Object.keys(ids).join(", ")}`);
  return ids;
}

type ClientScope = { id: string; name: string; protocolMappers?: { protocolMapper: string }[] };
type Mapper = { id?: string; name: string; protocol: string; protocolMapper: string; config: Record<string, string> };

async function organizationScopeId(): Promise<string> {
  const scopes = (await kcJson<ClientScope[]>(`/${REALM}/client-scopes`))!;
  const existing = scopes.find((scope) => scope.name === "organization");
  if (existing) return existing.id;
  await kc("POST", `/${REALM}/client-scopes`, {
    name: "organization",
    protocol: "openid-connect",
    attributes: { "include.in.token.scope": "true" },
    protocolMappers: [
      {
        name: "organization",
        protocol: "openid-connect",
        protocolMapper: "oidc-organization-membership-mapper",
        config: { "claim.name": "organization", multivalued: "true", "access.token.claim": "true", "id.token.claim": "true" }
      }
    ]
  });
  return (await kcJson<ClientScope[]>(`/${REALM}/client-scopes`))!.find((scope) => scope.name === "organization")!.id;
}

// Lesson 12: an MCP client (Claude Code) signs in through Keycloak in the browser and listens on
// this port on the doctor's own machine for the code. Same port as oauth.callbackPort in .mcp.json.
export const MCP_CLIENT_ID = "medinfo-mcp";
export const MCP_CALLBACK_PORT = 33418;

type ClientSettings = { clientId: string; redirectUris: string[] } & Record<string, unknown>;

// One routine for every client of this app: the settings, the two claims the API reads, and the
// organization scope. Creates the client or brings it back to these settings.
async function upsertClient(settings: ClientSettings) {
  let [client] = (await kcJson<{ id: string }[]>(`/${REALM}/clients?clientId=${settings.clientId}`))!;
  if (client) await kc("PUT", `/${REALM}/clients/${client.id}`, { ...settings, id: client.id });
  else {
    await kc("POST", `/${REALM}/clients`, settings);
    [client] = (await kcJson<{ id: string }[]>(`/${REALM}/clients?clientId=${settings.clientId}`))!;
  }

  const mappers: Mapper[] = [
    {
      // Tokens for this app name it as their audience; the server refuses any other token.
      name: "audience medinfo-api",
      protocol: "openid-connect",
      protocolMapper: "oidc-audience-mapper",
      config: { "included.custom.audience": AUDIENCE, "access.token.claim": "true", "id.token.claim": "false" }
    },
    {
      name: "country",
      protocol: "openid-connect",
      protocolMapper: "oidc-usermodel-attribute-mapper",
      config: {
        "user.attribute": "country",
        "claim.name": "country",
        "jsonType.label": "String",
        "access.token.claim": "true",
        "id.token.claim": "true",
        "userinfo.token.claim": "true"
      }
    }
  ];
  const existing = (await kcJson<Mapper[]>(`/${REALM}/clients/${client.id}/protocol-mappers/models`)) ?? [];
  for (const mapper of mappers) {
    const found = existing.find((item) => item.name === mapper.name);
    if (found) await kc("PUT", `/${REALM}/clients/${client.id}/protocol-mappers/models/${found.id}`, { ...mapper, id: found.id });
    else await kc("POST", `/${REALM}/clients/${client.id}/protocol-mappers/models`, mapper);
  }
  // The organization claim is always in the token, so the app never has to ask for it.
  await kc("PUT", `/${REALM}/clients/${client.id}/default-client-scopes/${await organizationScopeId()}`);
  console.log(`Client ${settings.clientId}: redirect ${settings.redirectUris.join(", ")}`);
}

const NO_SHORTCUTS = {
  protocol: "openid-connect",
  enabled: true,
  standardFlowEnabled: true,
  // The password grant and the implicit flow are off: the only way in is Keycloak's sign-in page.
  directAccessGrantsEnabled: false,
  implicitFlowEnabled: false,
  serviceAccountsEnabled: false,
  webOrigins: []
};

function setupClient(appUrl: string, clientSecret: string) {
  return upsertClient({
    ...NO_SHORTCUTS,
    clientId: CLIENT_ID,
    name: "HCP Medical Information",
    // Confidential: the secret stays on the server. The browser never holds a token.
    publicClient: false,
    clientAuthenticatorType: "client-secret",
    secret: clientSecret,
    redirectUris: [`${appUrl}/api/auth/callback`],
    attributes: { "pkce.code.challenge.method": "S256", "post.logout.redirect.uris": `${appUrl}/` }
  });
}

// Lesson 12. A program on the doctor's laptop cannot keep a secret, so this client is public and
// PKCE is required: a stolen code is useless without the verifier only that program holds. The
// token it gets is the doctor's own, with the same audience, company and country as the chat.
function setupMcpClient() {
  return upsertClient({
    ...NO_SHORTCUTS,
    clientId: MCP_CLIENT_ID,
    name: "HCP Medical Information for MCP clients",
    publicClient: true,
    redirectUris: [`http://localhost:${MCP_CALLBACK_PORT}/callback`, `http://127.0.0.1:${MCP_CALLBACK_PORT}/callback`],
    attributes: { "pkce.code.challenge.method": "S256" }
  });
}

type Person = { email: string; firstName: string; lastName: string; tenantId: string; country: string; role?: ReviewerRole };

// Lesson 13. A reviewer is a realm role, so it is in the token's realm_access claim. The app reads
// only these two; OpenFGA then asks whether the role holds for the item's company.
async function setupReviewerRoles(): Promise<Record<ReviewerRole, { id: string; name: string }>> {
  const descriptions: Record<ReviewerRole, string> = {
    "medical-reviewer": "Approves drafts before they are sent (lesson 13)",
    "safety-reviewer": "Files or dismisses adverse event reports (lesson 13)"
  };
  const roles = {} as Record<ReviewerRole, { id: string; name: string }>;
  for (const name of REVIEWER_ROLES) {
    const body = { name, description: descriptions[name] };
    const found = await kcJson<{ id: string; name: string }>(`/${REALM}/roles/${name}`);
    if (found) await kc("PUT", `/${REALM}/roles/${name}`, body);
    else await kc("POST", `/${REALM}/roles`, body);
    roles[name] = (await kcJson<{ id: string; name: string }>(`/${REALM}/roles/${name}`))!;
  }
  console.log(`Realm roles: ${REVIEWER_ROLES.join(", ")}`);
  return roles;
}

async function setupPeople(
  people: readonly Person[],
  organizations: Record<string, string>,
  roles: Record<ReviewerRole, { id: string; name: string }>,
  password: string
) {
  for (const person of people) {
    const body = {
      username: person.email,
      email: person.email,
      emailVerified: true,
      firstName: person.firstName,
      lastName: person.lastName,
      enabled: true,
      attributes: { country: [person.country] }
    };
    let [user] = (await kcJson<{ id: string }[]>(`/${REALM}/users?email=${encodeURIComponent(person.email)}&exact=true`))!;
    if (user) await kc("PUT", `/${REALM}/users/${user.id}`, body);
    else {
      await kc("POST", `/${REALM}/users`, body);
      [user] = (await kcJson<{ id: string }[]>(`/${REALM}/users?email=${encodeURIComponent(person.email)}&exact=true`))!;
    }
    await kc("PUT", `/${REALM}/users/${user.id}/reset-password`, { type: "password", value: password, temporary: false });
    // One company per person: leave any other, join the right one.
    for (const [alias, organizationId] of Object.entries(organizations)) {
      const members = (await kcJson<{ id: string }[]>(`/${REALM}/organizations/${organizationId}/members?max=1000`)) ?? [];
      const isMember = members.some((member) => member.id === user.id);
      if (alias === person.tenantId && !isMember) await kc("POST", `/${REALM}/organizations/${organizationId}/members`, user.id);
      if (alias !== person.tenantId && isMember) await kc("DELETE", `/${REALM}/organizations/${organizationId}/members/${user.id}`);
    }
    // At most one reviewer role, the listed one. A doctor has none.
    const held = (await kcJson<{ id: string; name: string }[]>(`/${REALM}/users/${user.id}/role-mappings/realm`)) ?? [];
    const wrong = held.filter((role) => (REVIEWER_ROLES as readonly string[]).includes(role.name) && role.name !== person.role);
    if (wrong.length) await kc("DELETE", `/${REALM}/users/${user.id}/role-mappings/realm`, wrong);
    if (person.role && !held.some((role) => role.name === person.role)) await kc("POST", `/${REALM}/users/${user.id}/role-mappings/realm`, [roles[person.role]]);
  }
}

// ---------- OpenFGA ----------

// The server returns the model with empty strings, nulls, lists and objects filled in and keys in its own order, so two
// copies of the same rules are compared with those differences removed.
function canonical(value: unknown): string {
  const strip = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(strip);
    if (!item || typeof item !== "object") return item;
    const entries = Object.entries(item)
      .map(([name, inner]) => [name, strip(inner)] as const)
      // One empty object has a meaning and stays: "this": {} means "assigned directly".
      .filter(([key, inner]) => {
        if (inner === undefined || inner === null || inner === "") return false;
        if (key === "this" || typeof inner !== "object") return true;
        return Array.isArray(inner) ? inner.length > 0 : Object.keys(inner).length > 0;
      })
      .sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries);
  };
  // Wrapped, so a missing field and an empty one compare equal too.
  return JSON.stringify(strip({ value }));
}

async function setupPermissions(apiToken: string) {
  const credentials = { method: CredentialsMethod.ApiToken, config: { token: apiToken } } as const;
  const admin = new OpenFgaClient({ apiUrl: FGA, credentials });
  const { stores } = await admin.listStores();
  const storeId = stores.find((store) => store.name === FGA_STORE_NAME)?.id ?? (await admin.createStore({ name: FGA_STORE_NAME })).id;
  const store = new OpenFgaClient({ apiUrl: FGA, storeId, credentials });

  const wanted = modelJson();
  const latest = await store.readLatestAuthorizationModel().catch(() => undefined);
  const same =
    latest?.authorization_model &&
    canonical(latest.authorization_model.type_definitions) === canonical(wanted.type_definitions) &&
    canonical(latest.authorization_model.conditions) === canonical(wanted.conditions);
  const modelId = same ? latest!.authorization_model!.id : (await store.writeAuthorizationModel(wanted)).authorization_model_id;

  const tuples = await syncDocumentTuples(new OpenFgaClient({ apiUrl: FGA, storeId, authorizationModelId: modelId, credentials }));
  setEnv({ FGA_STORE_ID: storeId, FGA_MODEL_ID: modelId });
  console.log(`OpenFGA store ${FGA_STORE_NAME}: model ${same ? "unchanged" : "written"}, ${tuples.total} document facts (${tuples.written} added, ${tuples.deleted} removed)`);
}

async function main() {
  const values = ensureSecrets();
  const appUrl = values.APP_URL || "http://127.0.0.1:3333";
  console.log("Starting Postgres, Keycloak and OpenFGA (the first start takes a minute)...");
  execFileSync("docker", ["compose", "--env-file", envFile, "-f", path.join(root, "infra/docker-compose.yml"), "up", "-d", "--wait"], {
    stdio: "inherit"
  });
  await signInAsAdmin(values.KEYCLOAK_ADMIN_PASSWORD);
  await setupRealm();
  await setupCountryAttribute();
  const organizations = await setupOrganizations();
  await setupClient(appUrl, values.OIDC_CLIENT_SECRET);
  await setupMcpClient();
  const roles = await setupReviewerRoles();
  await setupPeople(SEED_USERS, organizations, roles, values.SEED_USER_PASSWORD);
  console.log(`Doctors: ${SEED_USERS.map((doctor) => `${doctor.email} (${doctor.tenantId}, ${doctor.country})`).join(", ")}`);
  await setupPeople(SEED_REVIEWERS, organizations, roles, values.SEED_USER_PASSWORD);
  console.log(`Reviewers: ${SEED_REVIEWERS.map((reviewer) => `${reviewer.email} (${reviewer.tenantId}, ${reviewer.role})`).join(", ")}`);
  await setupPermissions(values.FGA_API_TOKEN);
  console.log(`\nDone. Open ${appUrl} and sign in as a doctor or a reviewer above; the password is SEED_USER_PASSWORD in your .env.`);
  console.log(`Keycloak admin: ${KEYCLOAK}/admin/master/console/#/${REALM} (user admin, password KEYCLOAK_ADMIN_PASSWORD in .env).`);
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

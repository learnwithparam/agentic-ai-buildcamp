import { execFileSync, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CredentialsMethod, OpenFgaClient, type TupleKey, type WriteAuthorizationModelRequest } from "@openfga/sdk";
import { LABEL_SECTIONS } from "../src/server/labels";
import { PROFILES } from "../src/server/content/records";
import { datasetTuples, documentTuples, hcpTuples } from "../src/server/permissions";
import { TENANTS } from "../src/server/users";

// Lesson 11. The permission rules are written once, in infra/openfga/model.fga. The OpenFGA CLI
// (pinned below) turns them into the JSON the server takes; setup and the tests both use this.

export const FGA_CLI_IMAGE = "openfga/cli:v0.8.2";
const MODEL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../infra/openfga");

export function modelJson(): WriteAuthorizationModelRequest {
  const out = execFileSync(
    "docker",
    ["run", "--rm", "-v", `${MODEL_DIR}:/w:ro`, FGA_CLI_IMAGE, "model", "transform", "--file", "/w/model.fga"],
    { encoding: "utf8" }
  );
  return JSON.parse(out) as WriteAuthorizationModelRequest;
}

// Runs the model's own tests (infra/openfga/model.fga.yaml). The CLI prints its summary on
// stderr and exits non-zero when any test fails.
export function testModel(): { ok: boolean; output: string } {
  const run = spawnSync(
    "docker",
    ["run", "--rm", "-v", `${MODEL_DIR}:/w:ro`, FGA_CLI_IMAGE, "model", "test", "--tests", "/w/model.fga.yaml"],
    { encoding: "utf8" }
  );
  return { ok: run.status === 0, output: `${run.stdout}${run.stderr}` };
}

const key = (tuple: TupleKey) => `${tuple.user}|${tuple.relation}|${tuple.object}`;

// The facts OpenFGA stores from the data itself: each document's company and country (lesson 11)
// and each doctor profile's company (lesson 14).
const STORED_TYPES = ["document:", "hcp:", "dataset:"];

// Makes the stored document and profile tuples equal to the data: adds the missing, deletes the stale.
export async function syncDocumentTuples(client: OpenFgaClient) {
  const wanted = new Map([...documentTuples(LABEL_SECTIONS), ...hcpTuples(PROFILES), ...datasetTuples(Object.keys(TENANTS))].map((tuple) => [key(tuple), tuple]));
  const stored = new Map<string, TupleKey>();
  let continuationToken: string | undefined;
  do {
    // OpenFGA reads a whole type only together with a user, so read every tuple and keep the
    // document ones. Doctor and reviewer facts arrive with each question; the inbox writes its own
    // draft and adverse_event tuples (lesson 13), and this leaves them alone.
    const page = await client.read({}, { continuationToken });
    for (const { key: tuple } of page.tuples) if (STORED_TYPES.some((type) => tuple.object.startsWith(type))) stored.set(key(tuple), { user: tuple.user, relation: tuple.relation, object: tuple.object });
    continuationToken = page.continuation_token || undefined;
  } while (continuationToken);
  const writes = [...wanted].filter(([id]) => !stored.has(id)).map(([, tuple]) => tuple);
  const deletes = [...stored].filter(([id]) => !wanted.has(id)).map(([, tuple]) => tuple);
  if (writes.length || deletes.length) await client.write({ writes, deletes }, { transaction: { disable: true, maxPerChunk: 50 } });
  return { written: writes.length, deleted: deletes.length, total: wanted.size };
}

// For the tests: a new store with the real rules and document facts, deleted by the caller, so
// the app's own store is never touched and CI needs no setup beyond the OpenFGA server.
export async function createTestStore(apiUrl: string, token: string) {
  const credentials = { method: CredentialsMethod.ApiToken, config: { token } } as const;
  const { id: storeId } = await new OpenFgaClient({ apiUrl, credentials }).createStore({ name: `medinfo-test-${Date.now()}` });
  const store = new OpenFgaClient({ apiUrl, storeId, credentials });
  const { authorization_model_id: modelId } = await store.writeAuthorizationModel(modelJson());
  const client = new OpenFgaClient({ apiUrl, storeId, authorizationModelId: modelId, credentials });
  await syncDocumentTuples(client);
  return { client, storeId, modelId };
}

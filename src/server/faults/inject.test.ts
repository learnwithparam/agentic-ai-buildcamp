import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import type { OpenFgaClient } from "@openfga/sdk";
import { LABEL_SECTIONS, statusOn, TODAY } from "../labels";
import { useFgaClient } from "../permissions";
import { executeTool, useLabelSearch, wordSearch } from "../tools";
import { scriptUser } from "../users";
import { AGENT_FAULTS, faultySearch, OPERATOR_DETAIL, PLANTED_CANARY, PLANTED_TEXT, supersededTwin, withFault } from "./inject";
import { AGENT_ERROR_REPLY, replyForError } from "./replies";
import { graceful } from "./score";

// Each fault, switched on around the real search_labels tool. The permission check is the one
// stand-in: OpenFGA is told the doctor may read every Pharma A document in the library.

const user = scriptUser();
const readable = new Set(LABEL_SECTIONS.filter((section) => section.tenantId === user.tenantId).map((section) => section.docId));
useFgaClient({ listObjects: async () => ({ objects: [...readable].map((id) => `document:${id}`) }) } as unknown as OpenFgaClient);
useLabelSearch(wordSearch);
afterEach(() => useLabelSearch(wordSearch));

type Result = { ok: boolean; results: Array<{ doc_id: string; section: string; status: string; text: string }> };
const ask = async (query = "CardioNex starting dose") => (await executeTool("search_labels", { query }, user, TODAY)) as unknown as Result;

test("there is a fault for each failure the brief names, except Keycloak, which is probed at the API", () => {
  assert.deepEqual([...AGENT_FAULTS].sort(), ["empty_search", "openfga_down", "planted_instruction", "superseded_label", "tool_throws"]);
});

test("planted instruction: the planted text reaches the tool result the agent reads, and only inside the fault", async () => {
  const clean = await ask();
  assert.ok(clean.results.length);
  assert.ok(!clean.results.some((hit) => hit.text.includes(PLANTED_CANARY)));
  const { value, log } = await withFault("planted_instruction", ask);
  assert.ok(value.results[0]!.text.includes(PLANTED_TEXT), "the first result carries the plant");
  assert.equal(log.injected, 1);
  assert.ok(log.honestText.length > 0, "the log keeps the text before the plant");
  assert.ok(!(await ask()).results.some((hit) => hit.text.includes(PLANTED_CANARY)), "the fault is off again afterwards");
});

test("superseded label: a document no longer in force comes back marked active", async () => {
  const { value, log } = await withFault("superseded_label", () => ask("CardioNex starting dose"));
  assert.equal(log.injected, 1);
  const swapped = value.results.find((hit) => log.supersededDocs.includes(hit.doc_id) && hit.status === "active");
  assert.ok(swapped, "the result says active");
  const doc = LABEL_SECTIONS.find((section) => section.docId === swapped.doc_id)!;
  assert.notEqual(statusOn(doc, TODAY), "active", "the library says it is not in force");
  const after = await ask("CardioNex starting dose");
  assert.ok(after.results.every((hit) => hit.status !== "active" || !log.supersededDocs.includes(hit.doc_id)), "off again: no superseded document is marked active");
});

test("superseded label: a section with no older version is left alone and nothing is logged as injected", async () => {
  const trial = LABEL_SECTIONS.find((section) => section.docId === "cardionex-clarion-hf-trial")!;
  assert.equal(supersededTwin(trial), undefined);
  const log = { injected: 0, supersededDocs: [], honestText: "" };
  const hits = await faultySearch("superseded_label", async () => [trial], log)("q", readable, 5, TODAY);
  assert.deepEqual(hits, [trial]);
  assert.equal(log.injected, 0);
});

test("empty search: search_labels finds nothing", async () => {
  const { value, log } = await withFault("empty_search", ask);
  assert.deepEqual(value.results, []);
  assert.equal(log.injected, 1);
});

test("tool throws: search_labels rejects with the operator detail, and the route's reply hides it", async () => {
  const { value } = await withFault("tool_throws", () => ask().then(() => null, (error: unknown) => error));
  assert.ok(value instanceof Error && value.message === OPERATOR_DETAIL);
  assert.equal(replyForError(value), AGENT_ERROR_REPLY);
  assert.equal(graceful(replyForError(value), true), true);
});

test("tool throws: the lookups throw too, not only search", async () => {
  const { value } = await withFault("tool_throws", () => executeTool("label_versions", { medicine: "CardioNex" }, user, TODAY).then(() => null, (error: unknown) => error));
  assert.ok(value instanceof Error);
});

test("OpenFGA down: the tool asks an OpenFGA that does not answer and rejects with the SDK's own error", async () => {
  const { value, log } = await withFault("openfga_down", () => ask().then(() => null, (error: unknown) => error));
  assert.equal(log.injected, 1);
  assert.ok(value instanceof Error, "the call failed");
  assert.match(String(value), /ECONNREFUSED|fetch failed|connect/i);
  assert.equal(replyForError(value), AGENT_ERROR_REPLY);
});

test("a fault is off again after its run, even when the run throws", async () => {
  await withFault("tool_throws", () => ask()).catch(() => {});
  assert.ok((await ask()).results.length > 0);
});

test("two runs at once under different faults never see each other's fault", async () => {
  const [planted, empty, clean] = await Promise.all([
    withFault("planted_instruction", async () => (await new Promise((resolve) => setTimeout(resolve, 20)), ask())),
    withFault("empty_search", ask),
    ask()
  ]);
  assert.ok(planted.value.results.some((hit) => hit.text.includes(PLANTED_CANARY)));
  assert.deepEqual(empty.value.results, []);
  assert.equal(planted.log.injected, 1);
  assert.equal(empty.log.injected, 1);
  assert.ok(clean.results.length && !clean.results.some((hit) => hit.text.includes(PLANTED_CANARY)));
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { OpenFgaClient } from "@openfga/sdk";
import { loadMedinfoCases } from "../../scripts/hcp-cases";
import { createTestStore } from "../../scripts/fga-model";
import { env } from "./env";
import { LABEL_SECTIONS, searchLabels } from "./labels";
import { readableDocuments } from "./permissions";
import { SEED_USERS, type Identity } from "./users";

// Lesson 11. The real OpenFGA server with the real rules (infra/openfga/model.fga) and the real
// document facts. The test makes its own store and deletes it after, so the app's store is untouched.

if (!env.fgaApiToken) throw new Error("FGA_API_TOKEN is not set. Run npm run identity:setup (lesson 11).");
let client: OpenFgaClient;

before(async () => {
  ({ client } = await createTestStore(env.fgaApiUrl, env.fgaApiToken));
});
after(async () => {
  await client?.deleteStore();
});

const doctor = (tenantId: string, country: string, userId = `kc-${tenantId}-${country}`): Identity => ({
  userId,
  name: "Test",
  email: `${userId}@example.com`,
  tenantId,
  country,
  roles: []
});

test("every dataset question, asked by every seeded doctor, finds only their company's text for their country", async () => {
  const questions = loadMedinfoCases().flatMap((item) => item.input.messages.map((message) => message.content));
  assert.ok(questions.length > 20);
  for (const seeded of SEED_USERS) {
    const readable = await readableDocuments(doctor(seeded.tenantId, seeded.country), client);
    // Pharma B has no label in Japan, so its Japanese doctor reads nothing: the COUNTRY cases rely on it.
    const hasText = LABEL_SECTIONS.some((section) => section.tenantId === seeded.tenantId && section.country === seeded.country);
    assert.equal(readable.size > 0, hasText, `${seeded.email} reads ${readable.size} documents`);
    for (const question of questions) {
      for (const hit of searchLabels(question, readable, LABEL_SECTIONS.length)) {
        assert.equal(hit.tenantId, seeded.tenantId, `${seeded.email} got ${hit.docId} for "${question}"`);
        assert.equal(hit.country, seeded.country, `${seeded.email} got ${hit.docId} for "${question}"`);
      }
    }
  }
});

test("each company still finds its own medicine, and never the other's", async () => {
  const a = await readableDocuments(doctor("pharma_a", "US"), client);
  const b = await readableDocuments(doctor("pharma_b", "US"), client);
  assert.ok(searchLabels("CardioNex starting dose", a).some((hit) => hit.docId.startsWith("cardionex")));
  assert.ok(searchLabels("NeuroVex dizziness stopped treatment", b).some((hit) => hit.docId === "neurovex-trial-summary"));
  assert.deepEqual(searchLabels("NeuroVex dizziness stopped treatment", a).filter((hit) => hit.docId.startsWith("neurovex")), []);
});

test("a country with no approved text, or an unknown company, reads nothing", async () => {
  assert.equal((await readableDocuments(doctor("pharma_a", "BR"), client)).size, 0);
  assert.equal((await readableDocuments(doctor("pharma_z", "US"), client)).size, 0);
});

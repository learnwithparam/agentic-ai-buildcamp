import assert from "node:assert/strict";
import { test } from "node:test";
import { DESK_PROMPT, deskFacts, fillDeskPrompt } from "./desk-prompt";
import { TODAY } from "./labels";
import { SEED_USERS, type Identity } from "./users";

const doctor = (email: string): Identity => {
  const seed = SEED_USERS.find((each) => each.email === email)!;
  return { userId: `kc-${seed.lastName.toLowerCase()}`, email, name: seed.firstName, tenantId: seed.tenantId, country: seed.country, roles: [] };
};

// Fix 3. Before it, every company read one prompt that named Pharma A and CardioNex, and a
// get_desk_rules call whose example cited a CardioNex label, even for Pharma B.
test("a Pharma B prompt names its own medicine and never Pharma A's", () => {
  for (const email of ["chidi.okafor@pharma-b.example.com", "yui.tanaka@pharma-b.example.com"]) {
    const prompt = fillDeskPrompt(DESK_PROMPT, deskFacts(doctor(email), TODAY));
    assert.match(prompt, /Pharma B's medicines: NeuroVex\./);
    assert.doesNotMatch(prompt, /cardionex|pharma a/i, email);
    assert.doesNotMatch(prompt, /\{\{/, `${email}: a name was left unfilled`);
  }
});

test("the citation example is the company's own label in force", () => {
  assert.match(deskFacts(doctor("chidi.okafor@pharma-b.example.com"), TODAY).example, /^\[neurovex-[a-z0-9-]+, 2\.\d+\]$/);
  assert.match(deskFacts(doctor("lukas.weber@pharma-a.example.com"), TODAY).example, /^\[cardionex-de-[a-z0-9-]+, 2\.\d+\]$/);
});

test("the prompt says when the asker's country has no label in force", () => {
  const japan = deskFacts(doctor("yui.tanaka@pharma-b.example.com"), TODAY);
  const us = deskFacts(doctor("chidi.okafor@pharma-b.example.com"), TODAY);
  assert.notEqual(japan.approval, us.approval);
  assert.match(us.approval, /NeuroVex has a label in force in US\./);
});

// The search words are the model's. A fixed list ("dose, titration and weeks") made five dose
// questions return the same four sections.
test("the prompt adds no fixed search words and no desk-rules call", () => {
  assert.doesNotMatch(DESK_PROMPT, /get_desk_rules|include the words/);
  assert.match(DESK_PROMPT, /no earlier turn says which medicine or patient/);
  // A refused child question must not make the next patient a child (demo-turns, first chat).
  assert.match(DESK_PROMPT, /adult unless this message gives an age under 18/);
});

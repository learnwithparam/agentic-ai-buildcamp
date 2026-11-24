import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { TENANTS } from "../../server/users";
import { SUGGESTIONS } from "./suggestions";

// Lesson 11: a doctor is offered questions about their own company's medicines only.
test("every company on the desk has suggestions that name only its own medicines", () => {
  assert.deepEqual(Object.keys(SUGGESTIONS).sort(), Object.keys(TENANTS).sort());
  const every = Object.values(TENANTS).flatMap((tenant) => tenant.medicines);
  for (const [tenantId, prompts] of Object.entries(SUGGESTIONS)) {
    assert.ok(prompts.length > 0, `${tenantId} has no suggestions`);
    const own = TENANTS[tenantId].medicines;
    for (const prompt of prompts) {
      assert.ok(own.some((medicine) => prompt.includes(medicine)), `${tenantId}: "${prompt}" names none of its medicines`);
      for (const other of every.filter((medicine) => !own.includes(medicine))) assert.ok(!prompt.includes(other), `${tenantId}: "${prompt}" names ${other}`);
    }
  }
});

// The page shows whichever company signed in, so only suggestions.ts may name a medicine.
test("no other page file names a medicine", () => {
  const every = Object.values(TENANTS).flatMap((tenant) => tenant.medicines);
  const root = new URL("../", import.meta.url);
  const files = (readdirSync(root, { recursive: true }) as string[]).filter((file) => /\.tsx?$/.test(file) && !/suggestions(\.test)?\.ts$/.test(file));
  assert.ok(files.length > 3, "found no client files");
  for (const file of files) {
    const text = readFileSync(new URL(file, root), "utf8");
    for (const medicine of every) assert.ok(!text.includes(medicine), `src/client/${file} names ${medicine}`);
  }
});

import assert from "node:assert/strict";
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

import assert from "node:assert/strict";
import { test } from "node:test";
import { testModel } from "./fga-model";

// Lesson 11. The permission rules' own tests (infra/openfga/model.fga.yaml), run by the pinned
// OpenFGA CLI. Change "and" to "or" in can_read and this fails.
test("the permission rules pass their own tests", () => {
  const { ok, output } = testModel();
  assert.ok(ok, `OpenFGA model tests failed:\n${output}`);
  assert.match(output, /Tests (\d+)\/\1 passing/);
});

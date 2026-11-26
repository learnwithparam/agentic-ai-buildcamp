import assert from "node:assert/strict";
import { test } from "node:test";
import { linksFor } from "./nav";

const labels = (roles: string[]) => linksFor(roles).map((page) => page.label);

test("each role sees only the pages for its job, named by that job", () => {
  assert.deepEqual(labels([]), ["Ask", "My requests"]);
  assert.deepEqual(labels(["medical-reviewer"]), ["Ask", "Check an email", "Event log", "Nightly sweep", "Review queue"]);
  assert.deepEqual(labels(["safety-reviewer"]), ["Ask", "Event log", "Nightly sweep", "Review queue"]);
  assert.deepEqual(labels(["sales-rep"]), ["Ask", "Check an email", "Plan outreach", "Hand off work", "Event log", "Nightly sweep", "Review queue"]);
  assert.deepEqual(labels(["analyst"]), ["Ask", "Sales insights", "My requests"]);
});

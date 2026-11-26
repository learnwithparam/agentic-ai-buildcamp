import assert from "node:assert/strict";
import { test } from "node:test";
import { probeApi } from "./api";
import { AGENT_ERROR_REPLY } from "./replies";

// The API with OpenFGA or Keycloak not answering. Real routes, real sign-in check, real agent
// graph; no model is called, because every request fails before the model.

test("OpenFGA down: no route answers with a stack trace or operator detail", async () => {
  const probes = await probeApi("openfga_down");
  for (const probe of probes) {
    assert.deepEqual(probe.leaks, [], `${probe.route} (${probe.status}) leaked: ${probe.body.slice(0, 300)}`);
    assert.doesNotMatch(probe.body, /<pre>|<!DOCTYPE|\bat .*:\d+:\d+/, `${probe.route} answered an error page`);
  }
});

test("OpenFGA down: the chat route sends the fixed error reply, and the routes that need OpenFGA answer an error", async () => {
  const probes = new Map((await probeApi("openfga_down")).map((probe) => [probe.route, probe]));
  assert.ok(probes.get("POST /api/threads/:id/runs/stream")!.body.includes(AGENT_ERROR_REPLY));
  for (const route of ["POST /api/threads/:id/runs/stream", "POST /api/insights/threads", "GET /api/hcps"]) {
    assert.ok(probes.get(route)!.asked >= 1, `${route} reached the OpenFGA that does not answer`);
  }
  assert.equal(probes.get("GET /api/me")!.status, 200, "a route that needs no OpenFGA still works");
  for (const route of ["POST /api/insights/threads", "GET /api/hcps"]) {
    const probe = probes.get(route)!;
    assert.ok(probe.status >= 500 && probe.status < 600, `${route} answered ${probe.status}`);
    assert.ok(JSON.parse(probe.body).error, `${route} answers JSON with an error message`);
  }
});

test("Keycloak down: every route says to sign in, in JSON, and shows nothing about Keycloak", async () => {
  for (const probe of await probeApi("keycloak_down")) {
    assert.equal(probe.status, 401, probe.route);
    assert.deepEqual(JSON.parse(probe.body), { error: "Sign in first." });
    assert.deepEqual(probe.leaks, []);
  }
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { CHECK_IDS, GUIDE, composeMajor, parseComposePs, portsToTry, unhealthy } from "./doctor";

test("every doctor check has its own section in the troubleshooting page", () => {
  const guide = readFileSync(GUIDE, "utf8");
  for (const id of CHECK_IDS) assert.ok(guide.includes(`<a id="${id}"></a>`), `${GUIDE} has no section for the ${id} check`);
});

test("docker compose ps output reads in both shapes", () => {
  const row = { Service: "keycloak", State: "running", Health: "healthy" };
  assert.deepEqual(parseComposePs(`${JSON.stringify(row)}\n${JSON.stringify({ ...row, Service: "openfga" })}\n`).map((s) => s.Service), ["keycloak", "openfga"]);
  assert.deepEqual(parseComposePs(JSON.stringify([row])), [row]);
  assert.deepEqual(parseComposePs(""), []);
});

test("a missing, stopped or unhealthy service is named with its state", () => {
  const states = [
    { Service: "postgres", State: "running", Health: "healthy" },
    { Service: "keycloak", State: "running", Health: "starting" },
    { Service: "openfga", State: "exited" },
    { Service: "docling", State: "running", Health: "" }
  ];
  assert.deepEqual(unhealthy(states, ["postgres", "keycloak", "openfga", "docling", "redis"]), ["keycloak (starting)", "openfga (exited)", "redis (not started)"]);
});

test("compose v1 is too old, v2 and later pass", () => {
  assert.equal(composeMajor("2.29.1"), 2);
  assert.equal(composeMajor("v2.40.0\n"), 2);
  assert.equal(composeMajor("1.29.2"), 1);
});

test("only a down service's port is tried, so a running stack never blames itself", () => {
  assert.deepEqual(portsToTry([]), []);
  assert.deepEqual(portsToTry(["infra:docling", "langfuse:redis"]), [[5001, "Docling"]]);
});

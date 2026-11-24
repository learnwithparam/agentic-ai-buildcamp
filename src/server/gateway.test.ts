import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { loadMedinfoCases } from "../../scripts/hcp-cases";
import { checkInput, isBudgetSpent, withConnectionName } from "./gateway";
import { answerConversation } from "./medinfo-agent";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

// Lesson 10's promise: gateway.ts is the only door to a model. Walk every tracked source file.
test("no file but gateway.ts creates a model client or uses the provider key", () => {
  const files = execFileSync("git", ["ls-files", "src", "scripts"], { cwd: root, encoding: "utf8" })
    .split("\n")
    .filter((file) => /\.(ts|tsx|mts)$/.test(file) && !file.endsWith(".test.ts"))
    .filter((file) => !["src/server/gateway.ts", "src/server/env.ts"].includes(file));
  assert.ok(files.length > 20, "the walk found the source files");
  const doors = [/new OpenAI\s*\(/, /openaiApiKey/, /decisionsUrl/, /openrouter\.ai/];
  const offenders = files.flatMap((file) => {
    const text = readFileSync(path.join(root, file), "utf8");
    return doors.filter((door) => door.test(text)).map((door) => `${file} matches ${door}`);
  });
  assert.deepEqual(offenders, []);
});

test("the input check stops the coding request and lets every real question through", () => {
  const cases = loadMedinfoCases();
  const blocked = cases.filter((item) => checkInput(item.input.messages.at(-1)!.content)).map((item) => item.metadata.caseId);
  assert.deepEqual(blocked, ["GUARDRAIL-01"]);
  assert.match(checkInput("Write a Python script to scrape clinicaltrials.gov")!, /^OUT_OF_SCOPE/);
});

test("an out-of-scope request is answered with no model call at all", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const answer = await answerConversation([{ role: "user", content: "Write a Python script to scrape clinicaltrials.gov" }]);
    assert.match(answer, /^OUT_OF_SCOPE/);
    assert.deepEqual(calls, []);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("the door adds the connection to the model name, once", () => {
  assert.equal(JSON.parse(withConnectionName('{"model":"openai/gpt-6-luna"}')).model, "openrouter:openai/gpt-6-luna");
  assert.equal(JSON.parse(withConnectionName('{"model":"openrouter:openai/gpt-6-luna"}')).model, "openrouter:openai/gpt-6-luna");
});

test("only the gateway's spent-budget refusal counts as a spent budget", () => {
  const refusal = (code: string) => OpenAI.APIError.generate(429, { error: { code, message: "limit" } }, "limit", new Headers());
  assert.equal(isBudgetSpent(refusal("spend_limit_exceeded")), true);
  assert.equal(isBudgetSpent(refusal("rate_limit_exceeded")), false);
  assert.equal(isBudgetSpent(new Error("spend_limit_exceeded")), false);
});

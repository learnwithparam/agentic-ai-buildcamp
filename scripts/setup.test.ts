import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { checkNode, missingKeys, PRODUCTION_VARIANT } from "./setup";
import { PROMPT_VARIANTS } from "./prompt-variants";

const read = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const setup = read("scripts/setup.ts");
const scripts = JSON.parse(read("package.json")).scripts as Record<string, string>;

test("every npm script setup runs exists in package.json", () => {
  const called = [...setup.matchAll(/npm\("([^"]+)"/g)].map((match) => match[1]);
  assert.ok(called.length >= 6, "setup.ts runs fewer scripts than expected");
  for (const name of [...called, "setup", "dev", "identity:smoke"]) assert.ok(scripts[name], `package.json has no "${name}" script`);
});

test("every user setup prints is a seeded user", () => {
  const users = read("src/server/users.ts");
  const printed = setup.match(/[a-z.]+@pharma-[ab]\.example\.com/g) ?? [];
  assert.ok(printed.length > 0);
  for (const email of printed) assert.ok(users.includes(`"${email}"`), `${email} is not in src/server/users.ts`);
  const seeded = new Set(users.match(/[a-z.]+@pharma-[ab]\.example\.com/g));
  assert.equal(new Set(printed).size, seeded.size, "setup.ts does not list every seeded user");
});

test("the production prompt is a real variant", () => {
  assert.ok(PROMPT_VARIANTS[PRODUCTION_VARIANT]);
});

test("the README runs setup", () => {
  assert.match(read("README.md"), /npm run setup/);
});

test("node and key checks", () => {
  assert.equal(checkNode("v22.18.0"), null);
  assert.equal(checkNode("v24.1.0"), null);
  assert.match(checkNode("v22.17.9") ?? "", /too old/);
  assert.match(checkNode("v20.19.0") ?? "", /too old/);
  assert.deepEqual(missingKeys({ A: "x", B: " ", C: undefined }, ["A", "B", "C"]), ["B", "C"]);
});

// A first run on a fresh clone failed: compose refused to start Langfuse because the signing
// secret only langfuse:code-eval writes was not there yet. Every variable a Langfuse compose file
// requires must be written by a script setup runs before it starts Langfuse.
test("setup writes every variable Langfuse compose requires before it starts Langfuse", () => {
  const compose = read("langfuse/docker-compose.yml") + read("langfuse/workshop.override.yml");
  const required = new Set([...compose.matchAll(/\$\{([A-Z_]+):\?/g)].map((match) => match[1]));
  const writers: Record<string, string> = { LANGFUSE_CODE_EVAL_EXTERNAL_SIGNING_SECRET: "langfuse:code-eval" };
  const up = setup.indexOf('[...LANGFUSE, "up"');
  assert.ok(up > 0, "setup.ts no longer starts Langfuse with the LANGFUSE compose args");
  for (const name of required) {
    const writer = writers[name];
    assert.ok(writer, `${name} is required by a Langfuse compose file, and no script setup runs writes it`);
    const call = setup.indexOf(`npm("${writer}")`);
    assert.ok(call > 0 && call < up, `setup.ts must run ${writer} before it starts Langfuse, so ${name} exists`);
  }
});

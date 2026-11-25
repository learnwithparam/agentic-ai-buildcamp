import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// A promise about what the model does is proven on the real model, through the gateway, traced
// (npm run check:live). A hand-made model client that returns fixed answers proves only the
// answers someone wrote. So no file in the repo may build one. A test that must make no model
// call passes noModelCall (scripts/no-model-call.ts), which fails when it is called.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SELF = fileURLToPath(import.meta.url);

// The shapes a stand-in model client takes.
export const FAKE_MODEL = [
  { name: "a cast to the OpenAI client", pattern: /as\s+unknown\s+as\s+OpenAI\b/ },
  { name: "a hand-written completions.create", pattern: /completions\s*:\s*\{[\s\S]{0,200}?\bcreate\s*:/ },
  { name: "a hand-written embeddings.create", pattern: /embeddings\s*:\s*\{[\s\S]{0,200}?\bcreate\s*:/ },
  // A function that stands in for the model where code takes one (embed, model): fakeEmbed, fakeModel.
  { name: "a fake model function", pattern: /\bfake(Embed|Model|Completion|Llm|Chat)\w*\b/ }
];

export function fakeModels(text: string): string[] {
  return FAKE_MODEL.filter(({ pattern }) => pattern.test(text)).map(({ name }) => name);
}

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(full);
    return /\.(ts|tsx)$/.test(entry.name) ? [full] : [];
  });
}

test("no file builds a stand-in model client", () => {
  const found = [...sources(path.join(ROOT, "src")), ...sources(path.join(ROOT, "scripts"))]
    .filter((file) => file !== SELF)
    .flatMap((file) => fakeModels(readFileSync(file, "utf8")).map((name) => `${path.relative(ROOT, file)}: ${name}`));
  assert.deepEqual(found, []);
});

test("the check catches each shape of a stand-in", () => {
  assert.deepEqual(fakeModels("const model = { chat: { completions: { create: async () => ({}) } } } as unknown as OpenAI;"), [
    "a cast to the OpenAI client",
    "a hand-written completions.create"
  ]);
  assert.deepEqual(fakeModels("({ embeddings: { create: async () => ({ data: [] }) } }) as never"), ["a hand-written embeddings.create"]);
  assert.deepEqual(fakeModels("const search = vectorSearch(store, async (text) => fakeEmbed(text));"), ["a fake model function"]);
  assert.deepEqual(fakeModels("const completion = await openai.chat.completions.create({ model });"), []);
});

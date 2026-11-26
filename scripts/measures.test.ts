import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { checkMeasures, meets } from "./measures";

const HEAD = "| Part | Measure | Bar | Target | Measured | Run |\n| --- | --- | --- | --- | --- | --- |\n";

function rootWith(measures: Record<string, number>) {
  const root = mkdtempSync(path.join(tmpdir(), "measures-"));
  mkdirSync(path.join(root, "docs/runs"), { recursive: true });
  writeFileSync(path.join(root, "docs/runs/search.json"), JSON.stringify({ measures }));
  return root;
}

test("the real docs/measures.md has a valid shape", () => {
  assert.deepEqual(checkMeasures(), []);
});

test("targets compare in the right direction", () => {
  assert.equal(meets(">= 0.95", 0.96), true);
  assert.equal(meets(">= 0.95", 0.9), false);
  assert.equal(meets("<= 0", 0), true);
  assert.equal(meets("= 0", 1), false);
});

test("a pending row passes on a PR but fails a release", () => {
  const text = `${HEAD}| Search | recall@5 | PaperQA2 | >= 0.95 | pending | |\n`;
  assert.deepEqual(checkMeasures({ text }), []);
  assert.match(checkMeasures({ text, release: true })[0], /still pending/);
});

test("a value must match its run file and meet its target", () => {
  const root = rootWith({ "recall@5": 0.91 });
  const match = `${HEAD}| Search | recall@5 | PaperQA2 | >= 0.95 | 0.97 | [run](docs/runs/search.json) |\n`;
  assert.match(checkMeasures({ text: match, root }).join("\n"), /the page says 0.97, docs\/runs\/search.json says 0.91/);
  const honest = `${HEAD}| Search | recall@5 | PaperQA2 | >= 0.95 | 0.91 | [run](docs/runs/search.json) |\n`;
  assert.match(checkMeasures({ text: honest, root }).join("\n"), /misses the target/);
});

test("a value with no run file fails", () => {
  const text = `${HEAD}| Search | recall@5 | PaperQA2 | >= 0.95 | 0.97 | |\n`;
  assert.match(checkMeasures({ text })[0], /no run file link/);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { readGolds } from "../../../scripts/ae-eval";
import { env } from "../env";
import { modelClient, useService } from "../gateway";
import { detectEvent } from "./detect";
import { extractCase } from "./extract";

// The second pass and the extraction on the real model, through the gateway (npm run check:live).
// A handful of rows, so the run is cheap; the full 79 rows are npm run ae:measure.

useService("eval-runner");
const golds = readGolds();
const pick = (...ids: string[]) => ids.map((id) => golds.find((gold) => gold.id === id)!);

// Indirect wording and special situations the second pass exists for.
for (const gold of pick("ae-001", "ae-005", "ae-018", "ae-052", "ae-077")) {
  test(`${gold.id}: the second pass sees that something happened`, async () => {
    assert.equal((await detectEvent(modelClient(), env.openaiModel, gold.message)).happened, true, gold.message);
  });
}

// Questions about the label, with nothing that happened to a patient.
for (const gold of pick("ae-004", "ae-006", "ae-012", "ae-026")) {
  test(`${gold.id}: the second pass stays quiet on a question about the label`, async () => {
    assert.equal((await detectEvent(modelClient(), env.openaiModel, gold.message)).happened, false, gold.message);
  });
}

test("ae-001: the criteria are read from the words, and the unnamed product is missing", async () => {
  const gold = pick("ae-001")[0]!;
  const safety = await extractCase(modelClient(), env.openaiModel, gold.message);
  assert.deepEqual(safety.criteria, gold.criteria);
  assert.deepEqual(safety.missing, ["product"]);
});

test("ae-003: coded terms come from the dictionary and match the labelled preferred terms", async () => {
  const gold = pick("ae-003")[0]!;
  const safety = await extractCase(modelClient(), env.openaiModel, gold.message);
  const found = new Set(safety.events.flatMap((event) => (event.coded ? [event.coded.pt.code] : [])));
  for (const m of gold.meddra) assert.ok(found.has(m.pt), `PT ${m.pt} not found in ${[...found].join(", ")}`);
});

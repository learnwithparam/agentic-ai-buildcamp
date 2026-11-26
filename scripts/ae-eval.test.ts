import assert from "node:assert/strict";
import { test } from "node:test";
import { predictFromLabels, readGolds, score, type Gold, type Prediction } from "./ae-eval";

const none = { reporter: false, patient: false, product: false, event: false };
const gold = (id: string, route: "safety" | "answer", criteria = none, pts: string[] = []): Gold => ({
  id,
  tenant_id: "pharma_a",
  message: "m",
  is_adverse_event: route === "safety",
  expected_route: route,
  criteria,
  meddra: pts.map((pt) => ({ llt: `l-${pt}`, pt }))
});
const say = (router: boolean, second: boolean, criteria = none, pts: string[] = []): Prediction => ({ router_safety: router, second_pass_safety: second, criteria, pts });

test("recall and precision count either layer, and each layer alone", () => {
  const golds = [gold("a", "safety"), gold("b", "safety"), gold("c", "safety"), gold("d", "safety"), gold("e", "answer"), gold("f", "answer")];
  const predictions = [say(true, true), say(true, false), say(false, true), say(false, false), say(false, true), say(false, false)];
  const s = score(golds, predictions);
  assert.equal(s.recall, 0.75, "3 of 4 positives called by one layer or both");
  assert.equal(s.precision, 0.75, "3 of the 4 rows called are positive");
  assert.deepEqual(s.router_only, { recall: 0.5, precision: 1 });
  assert.deepEqual(s.second_pass_only, { recall: 0.5, precision: 0.667 });
});

test("criteria accuracy is per criterion; all four needs every one right", () => {
  const all = { reporter: true, patient: true, product: true, event: true };
  const golds = [gold("a", "safety", all), gold("b", "safety", all)];
  const s = score(golds, [say(true, true, all), say(true, true, { ...all, product: false, event: false })]);
  assert.equal(s.criteria_accuracy, 0.75);
  assert.equal(s.criteria_all_four, 0.5);
});

test("coding is the preferred terms found over those found or expected, on rows that expect terms only", () => {
  const golds = [gold("a", "safety", none, ["p1", "p2"]), gold("b", "safety", none, ["p3"]), gold("c", "answer")];
  const s = score(golds, [say(true, true, none, ["p1"]), say(true, true, none, ["p3", "p9"]), say(false, false, none, ["p4"])]);
  // row a: 1 of {p1,p2} = 0.5; row b: 1 of {p3,p9} = 0.5; row c expects none and is not scored
  assert.equal(s.coding_accuracy, 0.5);
});

test("no positives called is precision 1, not a division by zero", () => {
  const s = score([gold("a", "safety")], [say(false, false)]);
  assert.equal(s.recall, 0);
  assert.equal(s.precision, 1);
});

test("a prediction is needed for every row", () => {
  assert.throws(() => score([gold("a", "answer")], []), /one prediction/);
});

test("the planted mistakes of --fake give the numbers the arithmetic predicts on the 79 real rows", () => {
  const golds = readGolds();
  assert.equal(golds.length, 79);
  const positives = golds.filter((g) => g.expected_route === "safety").length;
  const s = score(golds, predictFromLabels(golds));
  // The first positive is missed by both layers; the router also misses the second and gives one false alarm.
  assert.equal(s.recall, Math.round(((positives - 1) / positives) * 1000) / 1000);
  assert.equal(s.precision, Math.round(((positives - 1) / positives) * 1000) / 1000);
  assert.equal(s.router_only.recall, Math.round(((positives - 2) / positives) * 1000) / 1000);
  assert.equal(s.criteria_accuracy, Math.round(((golds.length * 4 - 1) / (golds.length * 4)) * 1000) / 1000);
  assert.ok(s.coding_accuracy < 1 && s.coding_accuracy > 0.95);
});

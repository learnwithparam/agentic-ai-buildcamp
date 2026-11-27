import assert from "node:assert/strict";
import { test } from "node:test";
import { demoCaseIds, pickReleaseCases } from "./eval-release";
import { loadAllCases } from "./hcp-cases";
import { RELEASE_CASES } from "./release-gate";

const meta = (caseId: string, slice: string, split = "train", showcase?: string) => ({ metadata: { caseId, slice, split, showcase } }) as never;

test("every slice in the dataset has a release case", () => {
  const cases = loadAllCases();
  const slices = [...new Set(cases.map((item) => item.metadata.slice))];
  const covered = new Set(RELEASE_CASES.map((id) => cases.find((item) => item.metadata.caseId === id)!.metadata.slice));
  assert.deepEqual(slices.filter((slice) => !covered.has(slice)), [], "a slice has no release case");
  assert.equal(RELEASE_CASES.length, slices.length, "one release case per slice");
  assert.ok(slices.length >= 20, "the dataset has at least 20 slices");
});

test("the rule takes the holdout case, then the showcase case, then the lowest id", () => {
  const picked = pickReleaseCases([
    meta("A-02", "a", "train"), meta("A-01", "a", "train", "01"), meta("A-03", "a", "holdout"), meta("A-04", "a", "holdout"),
    meta("B-03", "b", "train"), meta("B-02", "b", "train", "02"), meta("B-01", "b", "train"),
    meta("C-02", "c", "train"), meta("C-01", "c", "train")
  ]);
  assert.deepEqual(picked, ["A-03", "B-02", "C-01"]);
});

test("a new slice gets a release case with no other change, and the pick does not depend on the order of the file", () => {
  const items = loadAllCases();
  const extra = meta("NEW-01", "brand-new-slice");
  assert.ok(pickReleaseCases([...items, extra]).includes("NEW-01"));
  assert.deepEqual([...pickReleaseCases([...items].reverse())].sort(), [...pickReleaseCases(items)].sort());
});

test("the release cases are cases in the dataset, none twice", () => {
  const ids = new Set(loadAllCases().map((item) => item.metadata.caseId));
  for (const id of RELEASE_CASES) assert.ok(ids.has(id), `${id} is not in the dataset`);
  assert.equal(new Set(RELEASE_CASES).size, RELEASE_CASES.length);
});

test("the demo set holds every release case and every showcase case, each once", () => {
  const demo = demoCaseIds();
  for (const id of RELEASE_CASES) assert.ok(demo.includes(id));
  for (const item of loadAllCases().filter((i) => i.metadata.showcase)) assert.ok(demo.includes(item.metadata.caseId));
  assert.equal(new Set(demo).size, demo.length);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { dictionary, Dictionary, UnknownCode, type MeddraFile } from "./meddra";

// MedDRA coding is code: the model proposes words, the dictionary supplies every code. No model call.

test("a code the dictionary does not hold is refused, at every level", () => {
  assert.throws(() => dictionary().byLltCode("99999999"), UnknownCode);
  assert.throws(() => dictionary().byPtCode("91999999"), UnknownCode);
  // A real MedDRA-looking code is no safer than a made-up one: only this file's codes exist here.
  assert.throws(() => dictionary().byLltCode("10002424"), /not in the dictionary/);
});

test("a proposed term becomes its LLT, PT and SOC; an unknown term gets no code", () => {
  const coded = dictionary().code("Angioedema");
  assert.ok(coded);
  assert.equal(coded.pt.name, "Angioedema");
  assert.equal(coded.llt.pt, coded.pt.code);
  assert.ok(coded.soc.name.length > 0);
  // Case and punctuation do not matter, and a lower level term reaches its preferred term.
  assert.equal(dictionary().code("  ANGIOEDEMA. ")?.pt.code, coded.pt.code);
  assert.equal(dictionary().code("a made up reaction word"), null);
  assert.equal(dictionary().code(""), null);
});

test("every term in the labelled reports codes to the preferred term the report expects", () => {
  const rows = readFileSync("data/hcp/safety/ae-reports.jsonl", "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
  let checked = 0;
  for (const row of rows) {
    for (const m of row.meddra as Array<{ llt: string; pt: string }>) {
      assert.equal(dictionary().byLltCode(m.llt).pt.code, m.pt, row.id);
      // Coding the LLT's own name gives the same preferred term.
      assert.equal(dictionary().code(dictionary().byLltCode(m.llt).llt.name)?.pt.code, m.pt, row.id);
      checked++;
    }
  }
  assert.ok(checked > 60);
});

test("a dictionary whose terms point at a missing parent is refused when loaded", () => {
  const bad: MeddraFile = { version: "T", soc: [{ code: "1", name: "S" }], pt: [{ code: "2", name: "P", soc: "9" }], llt: [] };
  assert.throws(() => new Dictionary(bad), /system organ class/);
  const orphan: MeddraFile = { version: "T", soc: [{ code: "1", name: "S" }], pt: [{ code: "2", name: "P", soc: "1" }], llt: [{ code: "3", name: "l", pt: "8" }] };
  assert.throws(() => new Dictionary(orphan), /preferred term/);
});

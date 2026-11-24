import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { sinceTime } from "../judge-calibrate";
import { readSet, setProblems } from "../seed-faithfulness-calibration";
import { CALIBRATION_FILE, calibrationProblems, cohenKappa, confusion, readCalibration, type Pair } from "./faithfulness";

const pairs = (rows: [boolean, boolean][]): Pair[] => rows.map(([human, judge]) => ({ human, judge }));

test("kappa is 1 when the judge agrees on every answer", () => {
  assert.equal(cohenKappa(pairs([[true, true], [false, false], [true, true], [false, false]])), 1);
});

test("a judge that calls every answer faithful scores kappa 0, however often it agrees", () => {
  const always = pairs([...Array(16).fill([true, true]), ...Array(4).fill([false, true])]);
  assert.equal(always.filter((p) => p.human === p.judge).length / always.length, 0.8);
  assert.equal(cohenKappa(always), 0);
});

test("kappa matches a hand-worked example", () => {
  // 10 answers: 4 both faithful, 4 both unfaithful, 1 each way. Observed 0.8, chance 0.5.
  const rows = pairs([...Array(4).fill([true, true]), ...Array(4).fill([false, false]), [true, false], [false, true]]);
  assert.ok(Math.abs(cohenKappa(rows) - 0.6) < 1e-9);
  assert.deepEqual(confusion(rows), { bothFaithful: 4, humanOnly: 1, judgeOnly: 1, bothUnfaithful: 4 });
});

test("the stored calibration clears the bar with the rubric the judge uses today", () => {
  assert.ok(existsSync(CALIBRATION_FILE), "Run npm run judge:calibrate -- --save after labelling (lesson 09).");
  const calibration = readCalibration();
  assert.ok(calibration.items.length >= 20, `Only ${calibration.items.length} labelled answers; the lesson uses 20.`);
  assert.deepEqual(calibrationProblems(calibration), []);
  const always = { ...calibration, items: calibration.items.map((item) => ({ ...item, judge: true })) };
  assert.notDeepEqual(calibrationProblems(always), [], "An always-faithful judge must fail the bar.");
});

test("the calibration set mixes faithful and unfaithful answers, and every edit is named", () => {
  assert.deepEqual(setProblems(readSet()), []);
  const allFaithful = readSet().map((item) => ({ ...item, label: true }));
  assert.notDeepEqual(setProblems(allFaithful), [], "A set with no unfaithful answer must fail.");
});

test("--since picks the window of the newest batch, and rejects anything else", () => {
  const now = Date.parse("2026-11-24T12:00:00.000Z");
  assert.equal(sinceTime("15m", now).toISOString(), "2026-11-24T11:45:00.000Z");
  assert.equal(sinceTime("2h", now).toISOString(), "2026-11-24T10:00:00.000Z");
  assert.equal(sinceTime("1d", now).toISOString(), "2026-11-23T12:00:00.000Z");
  assert.equal(sinceTime(undefined, now).getUTCFullYear(), 2020);
  assert.throws(() => sinceTime("15 minutes", now), /--since takes a number/);
});

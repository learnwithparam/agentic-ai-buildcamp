import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildCandidates, calibrationProblems, changeFirstNumber, criterionOf, firstSentence, flipVerdict, formatLabels, judgeAgreement,
  LABELS_FILE, mergeLabels, parseLabels, readLabelRows, summarizeLabels, TARGET_ITEMS, type LabelRow
} from "./eval-calibration";
import { loadAllCases } from "./hcp-cases";

const row = (id: string, a: LabelRow["labellerA"], b: LabelRow["labellerB"]): LabelRow => ({
  id, caseId: "X-01", slice: "s", question: "q", criterion: "c", answer: "a", labellerA: a, labellerB: b, edit: "ideal"
});

test("the candidates are 60, built by a rule from the dataset, the same every time", () => {
  const cases = loadAllCases();
  const first = buildCandidates(cases);
  assert.equal(first.length, TARGET_ITEMS);
  assert.deepEqual(buildCandidates([...cases].reverse()), first);
  assert.equal(new Set(first.map((c) => c.id)).size, first.length, "an id is used twice");
  const edited = first.filter((c) => c.edit !== "ideal").length;
  assert.ok(edited >= 20 && first.length - edited >= 20, `the set needs both kinds: ${edited} edited of ${first.length}`);
  for (const c of first) assert.ok(c.answer && c.criterion && c.question, `${c.id} has an empty field`);
});

test("every llm-rubric case that has an ideal answer is in the set, each with its rubric as the criterion", () => {
  const cases = loadAllCases().filter((item) => item.expectedOutput.rubrics.length && item.expectedOutput.idealAnswer);
  const set = buildCandidates(loadAllCases());
  assert.ok(cases.length >= 6);
  for (const item of cases) {
    const mine = set.filter((c) => c.caseId === item.metadata.caseId);
    assert.ok(mine.length >= 3, `${item.metadata.caseId} has ${mine.length} candidates`);
    for (const c of mine) assert.equal(c.criterion, item.expectedOutput.rubrics.join("\n"));
  }
});

test("the edit rules change what they say they change, and say so when there is nothing to change", () => {
  assert.equal(changeFirstNumber("Give 5mg [cardionex-uspi-v2, 2.2]."), "Give 10mg [cardionex-uspi-v2, 2.2].");
  assert.equal(changeFirstNumber("Above 5.0 mEq/L, no."), "Above 6.0 mEq/L, no.");
  assert.equal(changeFirstNumber("No numbers [doc-1, 2.2]."), null, "a number inside a citation is not changed");
  assert.equal(flipVerdict("No. Wait."), "Yes. Wait.");
  assert.equal(flipVerdict("Yes. Fine."), "No. Fine.");
  assert.equal(flipVerdict("Take it."), null);
  assert.equal(firstSentence("One. Two."), "One.");
  assert.equal(firstSentence("Only one."), null);
  const item = loadAllCases().find((i) => !i.expectedOutput.rubrics.length && i.expectedOutput.idealAnswer)!;
  assert.match(criterionOf(item), /^Says what this reference answer says/);
});

test("the labels file round-trips, keeps labels when the candidates are rebuilt, and refuses to lose one", () => {
  const rows = [row("a", "pass", "fail"), row("b", "", "")];
  assert.deepEqual(parseLabels(formatLabels(rows)), rows);
  // A tab or a line break in an answer would break the row, so each becomes a line break on the way back.
  const multiline = { ...row("c", "pass", "pass"), answer: "line one\nline two\twith a tab" };
  assert.equal(parseLabels(formatLabels([multiline]))[0]!.answer, "line one\nline two\nwith a tab");
  const candidates = buildCandidates(loadAllCases());
  const labelled = candidates.map((c, i) => ({ ...c, labellerA: i === 0 ? ("pass" as const) : ("" as const), labellerB: "" as const }));
  assert.equal(mergeLabels(labelled, candidates)[0]!.labellerA, "pass");
  assert.throws(() => mergeLabels([row("gone", "pass", "pass")], candidates), /no longer produced by the rule \(gone\)/);
  assert.equal(mergeLabels([row("gone", "", "")], candidates).length, candidates.length, "an unlabelled orphan is dropped");
  assert.throws(() => parseLabels("id\tcase\n"), /must start with/);
  assert.throws(() => parseLabels(formatLabels([row("a", "pass", "fail")]).replace("\tpass\t", "\tmaybe\t")), /pass or fail/);
});

test("the committed labels file holds the 60 candidates, with a label only where a person gave one", () => {
  const rows = readLabelRows(LABELS_FILE);
  assert.deepEqual(rows.map((r) => r.id), buildCandidates(loadAllCases()).map((c) => c.id), "run npm run evals:candidates");
  for (const r of rows) assert.ok(["", "pass", "fail"].includes(r.labellerA) && ["", "pass", "fail"].includes(r.labellerB));
});

test("labeller agreement, kappa and the judge's agreement match a hand-worked example", () => {
  // 10 rows both labelled: 4 both pass, 4 both fail, A pass B fail once, A fail B pass once. Raw 0.8, chance 0.5, kappa 0.6.
  const rows = [
    ...[1, 2, 3, 4].map((i) => row(`p${i}`, "pass", "pass")), ...[1, 2, 3, 4].map((i) => row(`f${i}`, "fail", "fail")),
    row("d1", "pass", "fail"), row("d2", "fail", "pass"), row("open", "pass", "")
  ];
  const labelling = summarizeLabels(rows);
  assert.equal(labelling.rows, 11);
  assert.equal(labelling.labelled, 10);
  assert.equal(labelling.labellerAgreement, 0.8);
  assert.ok(Math.abs(labelling.labellerKappa - 0.6) < 1e-9);
  assert.deepEqual(labelling.disputed, ["d1", "d2"]);
  assert.equal(labelling.consensus.length, 8);
  // The judge gets 7 of the 8 consensus rows right (it passes f4).
  const verdicts = Object.fromEntries(labelling.consensus.map((r) => [r.id, r.id === "f4" ? true : r.label]));
  const judged = judgeAgreement(labelling, verdicts);
  assert.equal(judged.n, 8);
  assert.equal(judged.agreement, 7 / 8);
  // Disputed rows are never held against the judge.
  assert.equal(judgeAgreement(labelling, { ...verdicts, d1: true, d2: false }).n, 8);
});

test("a judge that agrees only because it passes everything has kappa 0", () => {
  const rows = [...Array(8).keys()].map((i) => row(`p${i}`, "pass", "pass")).concat([row("f1", "fail", "fail"), row("f2", "fail", "fail")]);
  const labelling = summarizeLabels(rows);
  const everything = Object.fromEntries(rows.map((r) => [r.id, true]));
  const judged = judgeAgreement(labelling, everything);
  assert.equal(judged.agreement, 0.8);
  assert.equal(judged.kappa, 0);
});

test("the judge is called calibrated only with all 60 labels, labellers who agree, and a measured agreement at the bar", () => {
  const sixty = (disagree: number) => [...Array(TARGET_ITEMS).keys()].map((i) => row(`r${i}`, i % 2 ? "pass" : "fail", i < disagree ? (i % 2 ? "fail" : "pass") : i % 2 ? "pass" : "fail"));
  assert.deepEqual(calibrationProblems(summarizeLabels(sixty(0)), 0.9), []);
  assert.match(calibrationProblems(summarizeLabels(sixty(0).slice(0, 59)), 0.9)[0]!, /59 of 60/);
  assert.match(calibrationProblems(summarizeLabels(sixty(30)), 0.9)[0]!, /labellers agree at kappa/);
  assert.match(calibrationProblems(summarizeLabels(sixty(0)))[0]!, /has not been measured/);
  assert.match(calibrationProblems(summarizeLabels(sixty(0)), 0.8)[0]!, /below 0.85/);
});

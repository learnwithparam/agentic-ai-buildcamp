import assert from "node:assert/strict";
import { test } from "node:test";
import { checkWalk, compareOutput, emailOf, formatRow, parseRows, parseRuns, parseWalk, questionMisses, syncTags, writeRow, type WalkRow } from "./checkpoints-walk";

const page = [
  "# A lesson",
  "",
  "```walk",
  '{ "user": "ana", "ask": "What is the dose?", "route": "answer", "sections": ["cardionex-uspi-v2 2.2"], "cites": true }',
  '{ "user": "chidi", "ask": "And for kids?", "route": "stop" }',
  "```",
  "",
].join("\n");

test("a walk block gives one question per line", () => {
  const { asks, errors } = parseWalk(page);
  assert.deepEqual(errors, []);
  assert.equal(asks.length, 2);
  assert.deepEqual(asks[0], { user: "ana", ask: "What is the dose?", route: "answer", sections: ["cardionex-uspi-v2 2.2"], cites: true });
  assert.deepEqual(asks[1].sections, []);
  assert.equal(asks[1].cites, false);
});

test("a bad JSON line fails with its line number in the page", () => {
  const broken = page.replace('{ "user": "chidi"', '{ "user": chidi');
  const { asks, errors } = parseWalk(broken);
  assert.equal(asks.length, 1);
  assert.match(errors[0], /^walk block line 5: not JSON/);
});

test("a line without a route fails with its line number", () => {
  const { errors } = parseWalk(page.replace(', "route": "stop"', ""));
  assert.match(errors[0], /^walk block line 5: needs route/);
});

const lesson = [
  "Run it:",
  "",
  "<!-- run -->",
  "```bash",
  "echo 4 of 7",
  "```",
  "",
  "<!-- output -->",
  "```text",
  "label checks 4 of 7",
  "",
  "done",
  "```",
  "",
  "Not marked, so not run:",
  "```bash",
  "echo skipped",
  "```",
].join("\n");

test("only a bash block after <!-- run --> is run, with the block after <!-- output -->", () => {
  const runs = parseRuns(lesson);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, "echo 4 of 7");
  assert.equal(runs[0].line, 4);
  assert.equal(runs[0].quoted, "label checks 4 of 7\n\ndone");
});

test("a quoted line that the run printed passes", () => {
  assert.deepEqual(compareOutput("label checks 4 of 7\ndone", "start\n  label checks 4 of 7  \ndone\n"), []);
});

test("a quoted line that is missing fails", () => {
  const [problem] = compareOutput("label checks 4 of 7\ndone", "label checks 4 of 7\n");
  assert.match(problem, /^missing: .*"done"/);
});

test("a changed number fails as changed numbers, not as missing", () => {
  const [problem] = compareOutput("label checks 4 of 7", "label checks 5 of 7");
  assert.match(problem, /^numbers changed: .*"label checks 4 of 7".*"label checks 5 of 7"/);
});

const row: WalkRow = { tag: "checkpoint/20-rag", commit: "0123456789abcdef0123", date: "2026-11-26", questions: [2, 2], runs: [1, 1], traces: ["t1", "t2"], failure: "" };

test("the row writer formats a row and replaces the tag's older row, in lesson order", () => {
  assert.equal(formatRow(row), "| checkpoint/20-rag | 0123456789ab | 2026-11-26 | 2 of 2 | 1 of 1 | t1, t2 | none |");
  const first = writeRow(undefined, row);
  const other = writeRow(first, { ...row, tag: "checkpoint/05-dataset", commit: "aaaaaaaaaaaaaaaa" });
  assert.deepEqual(parseRows(other).map((each) => each.tag), ["checkpoint/05-dataset", "checkpoint/20-rag"]);
  const again = writeRow(other, { ...row, commit: "bbbbbbbbbbbbbbbb", failure: 'a | b "x"' });
  assert.deepEqual(parseRows(again).map((each) => each.commit), ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]);
  assert.match(again, /a \/ b "x"/);
});

const TAGS = ["checkpoint/19-cli", "checkpoint/20-rag"];
const tips: Record<string, string> = { "checkpoint/19-cli": "1111111111111111", "checkpoint/20-rag": "0123456789abcdef0123" };
const commitOf = (tag: string) => tips[tag];

test("a row for every tag at its commit passes", () => {
  const text = writeRow(writeRow(undefined, { ...row, tag: "checkpoint/19-cli", commit: "1111111111111111" }), row);
  assert.deepEqual(checkWalk({ text, tags: TAGS, commitOf }), []);
});

test("a tag with no row fails", () => {
  const text = writeRow(undefined, row);
  assert.match(checkWalk({ text, tags: TAGS, commitOf })[0], /checkpoint\/19-cli has no row/);
});

test("a row that names an older commit than the tag fails", () => {
  const text = writeRow(writeRow(undefined, { ...row, tag: "checkpoint/19-cli", commit: "9999999999999999" }), row);
  assert.match(checkWalk({ text, tags: TAGS, commitOf })[0], /row for checkpoint\/19-cli names 999999999999.*Walk it again/);
});

test("a tag the clone does not have is skipped", () => {
  const text = writeRow(undefined, row);
  assert.deepEqual(checkWalk({ text, tags: TAGS, commitOf: (tag) => (tag === "checkpoint/20-rag" ? tips[tag] : undefined) }), []);
});

test("before the file exists, not walked yet is a problem only on a release", () => {
  assert.deepEqual(checkWalk({ tags: TAGS, commitOf }), []);
  assert.match(checkWalk({ tags: TAGS, commitOf, release: true })[0], /not walked yet/);
});

test("a question is judged on route, sections and citation", () => {
  const want = parseWalk(page).asks[0];
  const seen = { tier: "answer", sections: ["cardionex-uspi-v2 2.2"], reply: "5 mg [cardionex-uspi-v2, 2.2]" };
  const cited = (reply: string) => /\[.+\]/.test(reply);
  assert.deepEqual(questionMisses(want, seen, cited), []);
  assert.match(questionMisses(want, { ...seen, tier: "stop" }, cited)[0], /route was stop, wanted answer/);
  assert.match(questionMisses(want, { ...seen, sections: ["x 1"] }, cited)[0], /section cardionex-uspi-v2 2\.2 was not found/);
  assert.match(questionMisses(want, { ...seen, reply: "5 mg" }, cited)[0], /no citation/);
});

test("a demo user is an email or a first name", () => {
  assert.equal(emailOf("ana"), "ana.rivera@pharma-a.example.com");
  assert.equal(emailOf("a@b.example.com"), "a@b.example.com");
  assert.throws(() => emailOf("nobody"), /not a demo user/);
});

test("the tags come from the sync script's list", () => {
  const tags = syncTags("TAGS=(\n  checkpoint/00-setup\n  checkpoint/01-base-app\n)\nfoo checkpoint/x\n");
  assert.deepEqual(tags, ["checkpoint/00-setup", "checkpoint/01-base-app"]);
});

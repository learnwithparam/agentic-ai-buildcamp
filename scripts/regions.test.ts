import { expect, test } from "bun:test";
import { finishedBefore, regionsIn, render } from "./regions";

const SAMPLE = [
  "const first = 1;",
  "// #region step:intent-routing",
  "const route = pick(question);",
  "// #stub",
  "//~ // TODO(intent-routing): pick a route",
  '//~ const route = "agent";',
  "// #endregion",
  "const last = 2;",
].join("\n");

test("a finished region keeps its answer and drops the markers", () => {
  const out = render(SAMPLE, new Set(["intent-routing"]));
  expect(out).toContain("pick(question)");
  expect(out).not.toContain("TODO");
  expect(out).not.toContain("#region");
});

test("an unfinished region keeps its stub with the TODO", () => {
  const out = render(SAMPLE, new Set());
  expect(out).toContain("// TODO(intent-routing)");
  expect(out).toContain('const route = "agent";');
  expect(out).not.toContain("//~");
  expect(out).not.toContain("pick(question)");
  expect(out).toContain("const first = 1;");
});

test("a broken marker throws", () => {
  expect(() => regionsIn("// #region step:intent-routing\nx")).toThrow("not closed");
  expect(() => regionsIn("// #region step:nope\n// #stub\n// #endregion")).toThrow("no module");
  expect(() => regionsIn("// #region step:foundation\nx\n// #endregion")).toThrow("no #stub");
});

test("a module starts with every earlier module finished and none after", () => {
  const done = finishedBefore("intent-routing");
  expect(done.has("documents-freshness")).toBe(true);
  expect(done.has("intent-routing")).toBe(false);
  expect(done.has("grounded-answer")).toBe(false);
});

test("a lab starts from its module end state plus the earlier labs", () => {
  const done = finishedBefore("product-intelligence-bi");
  expect(done.has("surfaces")).toBe(true);
  expect(done.has("research-knowledge")).toBe(true);
  expect(done.has("access-control")).toBe(false);
});

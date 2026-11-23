import { describe, expect, test } from "bun:test";
import { branchNames } from "../src/branches";
import { plan } from "./branch-workshop";

describe("branch-workshop", () => {
  test("it makes every branch from a release tag", () => {
    const result = plan("v1.0.0", { isTag: true, existing: [] });
    expect(result).toEqual({ ok: true, make: branchNames(), skip: [] });
  });
  test("it skips a branch that already exists", () => {
    const first = branchNames()[0];
    const result = plan("v1.0.0", { isTag: true, existing: [first, "main"] });
    expect(result.ok && result.skip).toEqual([first]);
    expect(result.ok && result.make.includes(first)).toBe(false);
  });
  test("it refuses a checkpoint branch as the start", () => {
    const result = plan(branchNames()[0], { isTag: false, existing: [] });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("checkpoint branch");
  });
  test("it refuses a name that is not a tag", () => {
    expect(plan("main", { isTag: false, existing: [] }).ok).toBe(false);
    expect(plan("", { isTag: false, existing: [] }).ok).toBe(false);
  });
});

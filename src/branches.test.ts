import { describe, expect, test } from "bun:test";
import { branchNames, checkpointBranches, isUnitBranch, labBranches } from "./branches";
import { branchFor, UNITS } from "./workshop";

describe("the branch list", () => {
  test("it has one branch for every unit, in order", () => {
    expect(branchNames()).toEqual(UNITS.map((unit) => branchFor(unit.slug)));
  });
  test("modules are checkpoints and labs are labs", () => {
    expect(checkpointBranches().every((name) => name.startsWith("checkpoint/"))).toBe(true);
    expect(labBranches().every((name) => name.startsWith("lab/"))).toBe(true);
    expect(checkpointBranches().length + labBranches().length).toBe(UNITS.length);
  });
  test("every name is unique", () => {
    expect(new Set(branchNames()).size).toBe(UNITS.length);
  });
  test("it knows a unit branch, with or without a remote prefix", () => {
    const name = branchNames()[0];
    expect(isUnitBranch(name)).toBe(true);
    expect(isUnitBranch(`origin/${name}`)).toBe(true);
    expect(isUnitBranch("main")).toBe(false);
  });
});

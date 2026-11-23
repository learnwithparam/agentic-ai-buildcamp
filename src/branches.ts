// The names of every branch a workshop repo holds. Each name comes from branchFor.
import { branchFor, UNITS } from "./workshop";

// One name per unit, in course order: the checkpoints first, then the labs.
export function branchNames(): string[] {
  return UNITS.map((unit) => branchFor(unit.slug));
}

export function checkpointBranches(): string[] {
  return UNITS.filter((unit) => unit.kind === "module").map((unit) => branchFor(unit.slug));
}

export function labBranches(): string[] {
  return UNITS.filter((unit) => unit.kind === "lab").map((unit) => branchFor(unit.slug));
}

// True for a name that a unit owns, so a script can refuse to start from one.
export function isUnitBranch(name: string): boolean {
  return branchNames().includes(name.replace(/^(origin|refs\/heads)\//, ""));
}

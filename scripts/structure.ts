// Reads the repo layout once. Every other script asks this file where things are.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export const ROOT = join(import.meta.dir, "..");

export type Step = {
  name: string; // verb-the-thing, also the command argument
  dir: string;
  part: string;
  meta: { minutes: number; screen: boolean; solution: boolean };
};
export type Part = { name: string; dir: string; steps: Step[] };

// step.toml as an author writes it; every key may be missing.
type StepToml = { minutes?: unknown; screen?: unknown; solution?: unknown };

function subfolders(folder: string): string[] {
  if (!existsSync(folder)) return [];
  const entries = readdirSync(folder);
  const folders = entries.filter((entry) => statSync(join(folder, entry)).isDirectory());
  return folders.sort();
}

// Folders keep an order prefix for sorting only. Learners never type it.
export const bareName = (folder: string) => folder.replace(/^\d+-/, "");

function readStep(partFolder: string, partName: string, stepFolderName: string): Step {
  const stepFolder = join(partFolder, stepFolderName);
  const metaPath = join(stepFolder, "step.toml");
  let meta: StepToml = {};
  if (existsSync(metaPath)) meta = Bun.TOML.parse(readFileSync(metaPath, "utf8")) as StepToml;
  return {
    name: bareName(stepFolderName),
    dir: stepFolder,
    part: partName,
    meta: {
      minutes: Number(meta.minutes ?? 0),
      screen: Boolean(meta.screen),
      solution: Boolean(meta.solution),
    },
  };
}

export function parts(): Part[] {
  const partsFolder = join(ROOT, "parts");
  return subfolders(partsFolder).map((partFolderName) => {
    const partFolder = join(partsFolder, partFolderName);
    const partName = bareName(partFolderName);
    const steps = subfolders(partFolder).map((stepFolderName) =>
      readStep(partFolder, partName, stepFolderName),
    );
    return { name: partName, dir: partFolder, steps };
  });
}

export const allSteps = () => parts().flatMap((part) => part.steps);

export function findStep(name: string): Step | undefined {
  return allSteps().find((step) => step.name === name);
}

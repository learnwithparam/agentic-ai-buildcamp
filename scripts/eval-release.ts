/**
 * Which cases the release gate runs: one per slice, chosen by a rule, not a list.
 *
 * For each slice in `metadata.slice`, the gate takes the case that
 *   1. is in the holdout split, because no prompt was tuned on it, else
 *   2. is marked showcase, because a lesson teaches it, else
 *   3. has the lowest id.
 * A slice added to the dataset gets a release case with no code change, and
 * scripts/release-gate.test.ts fails if any slice has none.
 */
import { loadAllCases, type CaseItem } from "./hcp-cases";

type Pickable = Pick<CaseItem, "metadata">;

export function pickReleaseCases<T extends Pickable>(items: T[]): string[] {
  const bySlice = new Map<string, T[]>();
  for (const item of items) bySlice.set(item.metadata.slice, [...(bySlice.get(item.metadata.slice) ?? []), item]);
  const rank = (item: T) => (item.metadata.split === "holdout" ? 0 : item.metadata.showcase ? 1 : 2);
  return [...bySlice.values()].map((group) => [...group].sort((a, b) => rank(a) - rank(b) || a.metadata.caseId.localeCompare(b.metadata.caseId))[0]!.metadata.caseId);
}

export const releaseCaseIds = () => pickReleaseCases(loadAllCases());

// The demo set the pass^k measure runs: the release cases plus every showcase case.
export function demoCaseIds(items: Pickable[] = loadAllCases()): string[] {
  const release = new Set(pickReleaseCases(items));
  return items.filter((item) => release.has(item.metadata.caseId) || item.metadata.showcase).map((item) => item.metadata.caseId);
}

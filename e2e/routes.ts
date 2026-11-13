// Every page a learner opens while they do the course. The audit visits each at 1280 px and 375 px.
// The three pages live on three ports; scripts/text-audit.ts starts all three.
export type Route = { name: string; path: string };

export const routes: Route[] = [
  { name: "ledger", path: "http://localhost:7700/ledger" },
  { name: "board", path: "http://localhost:7701/board" },
  { name: "trace viewer", path: "http://localhost:7703/" },
];

// Button verbs this course uses beyond the shared list, in lower case.
export const extraButtonVerbs: string[] = [];

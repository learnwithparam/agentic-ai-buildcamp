// Golden cases: the truth a behaviour is graded against. The expected answer is data.

export type CaseKind = "naive" | "happy" | "edge" | "adversarial";
export type Intent = "answer" | "refuse" | "template" | "escalate" | "approve";

export type GoldenCase = {
  name: string; // matches a name in a unit's `cases` list in src/workshop.ts
  kind: CaseKind;
  intent: Intent;
  question: string;
  persona: string; // a seeded person, by name
  brand?: string;
  country?: string;
  documentType?: string;
  truth: Record<string, unknown>; // the expected facts, computed from the catalog
};

export type GoldenSet = { track: "hcp" | "mission-control"; cases: GoldenCase[] };

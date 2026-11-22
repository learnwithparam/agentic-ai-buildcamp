// The one list of modules and labs. Tags, pages, checks and the README table all read this file.
// A module teaches on the HCP agent (the instructor builds it). A lab builds Mission Control.

export type Track = "hcp" | "mission-control";

export type Unit = {
  slug: string;
  kind: "module" | "lab";
  track: Track;
  title: string;
  job: string; // the subtitle: the real job this unit does for the company
  needs: string | null; // the one unit that must pass first
  after: string | null; // labs only: the module whose tag a lab starts from
  cases: string[]; // golden case names this unit turns green
};

export const UNITS: Unit[] = [
  {
    slug: "foundation",
    kind: "module",
    track: "hcp",
    title: "Run the stack and meet the naive agent",
    job: "See why a plain chatbot fails a medical affairs team",
    needs: null,
    after: null,
    cases: [],
  },
  {
    slug: "gateway-tracing",
    kind: "module",
    track: "hcp",
    title: "Route every model call through a gateway and trace it",
    job: "Show the team why an answer came out and what it cost",
    needs: "foundation",
    after: null,
    cases: [],
  },
  {
    slug: "documents-freshness",
    kind: "module",
    track: "hcp",
    title: "Ingest documents and keep them fresh",
    job: "Make sure the agent quotes the current label, never the old one",
    needs: "gateway-tracing",
    after: null,
    cases: ["current-label-wins", "expired-draft-hidden"],
  },
  {
    slug: "intent-routing",
    kind: "module",
    track: "hcp",
    title: "Route each question before the agent loop runs",
    job: "Send trivia and off-label requests down cheap, safe paths",
    needs: "documents-freshness",
    after: null,
    cases: ["trivia-template", "off-label-refused"],
  },
  {
    slug: "grounded-agent",
    kind: "module",
    track: "hcp",
    title: "Answer only from cited sources",
    job: "Give medical reviewers answers they can check line by line",
    needs: "intent-routing",
    after: null,
    cases: ["multi-hop-cited", "unanswerable-refused", "wrong-country-label"],
  },
  {
    slug: "analytics-mcp",
    kind: "module",
    track: "hcp",
    title: "Query any schema through a tool, never raw rows",
    job: "Answer territory sales questions without leaking prescriber data",
    needs: "grounded-agent",
    after: null,
    cases: ["territory-dip", "second-schema", "no-row-in-trace"],
  },
  {
    slug: "surfaces",
    kind: "module",
    track: "hcp",
    title: "Serve one agent on the web, MCP and the command line",
    job: "Let the team reach the agent where they already work",
    needs: "analytics-mcp",
    after: null,
    cases: ["same-answer-three-surfaces"],
  },
  {
    slug: "access-control",
    kind: "module",
    track: "hcp",
    title: "Decide who may see what, by role, attribute and relationship",
    job: "Keep each pharma tenant and each role inside its own lane",
    needs: "surfaces",
    after: null,
    cases: ["tenant-wall", "role-hides-bi", "country-attribute", "policy-matches-rls"],
  },
  {
    slug: "approvals-memory",
    kind: "module",
    track: "hcp",
    title: "Pause for a human and remember per user",
    job: "Route an adverse event report to the safety officer for approval",
    needs: "access-control",
    after: null,
    cases: ["adverse-event-pause", "resume-after-restart", "memory-stays-in-tenant"],
  },
  {
    slug: "guardrails-workers",
    kind: "module",
    track: "hcp",
    title: "Guard the inputs and run workers that never double up",
    job: "Watch for label changes overnight and survive a crash",
    needs: "approvals-memory",
    after: null,
    cases: ["injection-in-pdf", "select-star-blocked", "duplicate-events-one-run", "crash-resumes"],
  },
  {
    slug: "release-gate",
    kind: "module",
    track: "hcp",
    title: "Gate every release on a golden set",
    job: "Stop a one line change from bringing back the old label",
    needs: "guardrails-workers",
    after: null,
    cases: ["regression-caught"],
  },
  {
    slug: "research-knowledge",
    kind: "lab",
    track: "mission-control",
    title: "Research rival pricing pages",
    job: "Tell the product lead when a rival changes its price",
    needs: "grounded-agent",
    after: "grounded-agent",
    cases: ["price-swap", "unchanged-page-skipped", "cookie-wall", "hidden-price-tabs"],
  },
  {
    slug: "product-intelligence-bi",
    kind: "lab",
    track: "mission-control",
    title: "Answer funnel questions with a second agent",
    job: "Spot churn risk in the product funnel and hand it to the briefing agent",
    needs: "surfaces",
    after: "surfaces",
    cases: ["funnel-drop", "churn-skill", "no-email-in-trace"],
  },
  {
    slug: "tenancy-and-memory",
    kind: "lab",
    track: "mission-control",
    title: "Keep two workspaces apart",
    job: "Stop Core Growth from reading the Titan memo",
    needs: "approvals-memory",
    after: "approvals-memory",
    cases: ["titan-hidden", "tone-memory-scoped", "approval-resumes"],
  },
  {
    slug: "always-on-teammates",
    kind: "lab",
    track: "mission-control",
    title: "Run the teammates on events and a schedule",
    job: "Publish the Monday briefing after a person approves it",
    needs: "release-gate",
    after: "release-gate",
    cases: ["event-to-run", "monday-briefing", "debounce", "crash-resume", "publish-approval"],
  },
];

export function unitBySlug(slug: string): Unit | undefined {
  return UNITS.find((unit) => unit.slug === slug);
}

// The tag name for a unit, for example checkpoint/03-intent-routing.
export function tagFor(slug: string): string {
  const unit = unitBySlug(slug);
  if (unit === undefined) throw new Error(`No module or lab named ${slug}`);
  const same = UNITS.filter((other) => other.kind === unit.kind);
  const place = same.indexOf(unit);
  const name = unit.kind === "module" ? "checkpoint" : "lab";
  const number = String(unit.kind === "module" ? place : place + 1).padStart(2, "0");
  return `${name}/${number}-${slug}`;
}

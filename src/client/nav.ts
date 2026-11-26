import { ANALYST_ROLE, REVIEWER_ROLES, STAFF_ROLES } from "../server/users";

// Step 2B. The top bar. Each link is named by the job it does for the person signed in, and shown
// only to the roles that do that job: the email check for staff (lesson 14), outreach and hand-offs
// for reps (lessons 14 and 15), the event log and the nightly sweep for reviewers (lessons 16 and
// 17), insights for analysts (lesson 22). A link only spares someone a page they cannot use; the
// server refuses the page's data to anyone not allowed it.
export type Page = { path: string; label: string; roles?: readonly string[] };

export const PAGES: Page[] = [
  { path: "/", label: "Ask" },
  { path: "/editor", label: "Check an email", roles: STAFF_ROLES },
  { path: "/outreach", label: "Plan outreach", roles: ["sales-rep"] },
  { path: "/handoffs", label: "Hand off work", roles: ["sales-rep"] },
  { path: "/events", label: "Event log", roles: REVIEWER_ROLES },
  { path: "/sweep", label: "Nightly sweep", roles: REVIEWER_ROLES },
  { path: "/insights", label: "Sales insights", roles: [ANALYST_ROLE] },
  { path: "/inbox", label: "Inbox" }
];

const isReviewer = (roles: readonly string[]) => roles.some((role) => (REVIEWER_ROLES as readonly string[]).includes(role));

export const mayOpen = (page: Page, roles: readonly string[]) => !page.roles || roles.some((role) => page.roles!.includes(role));

// The links one person sees, in order, with the inbox named for what it is to them: a queue to
// decide for a reviewer, a list of their own requests for anyone else.
export const linksFor = (roles: readonly string[]): Page[] =>
  PAGES.filter((page) => mayOpen(page, roles)).map((page) =>
    page.path === "/inbox" ? { ...page, label: isReviewer(roles) ? "Review queue" : "My requests" } : page
  );

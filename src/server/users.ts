// Who may ask, and which desk each one asks (lesson 11).

// The signed-in user, read from a Keycloak access token the server verified.
// Lesson 13: roles are the Keycloak realm roles that let someone decide a review item.
// Lesson 14: a sales rep approves outreach steps.
export const REVIEWER_ROLES = ["medical-reviewer", "safety-reviewer", "sales-rep"] as const;
export type ReviewerRole = (typeof REVIEWER_ROLES)[number];
// Lesson 14. The roles that use the email editor and the rep board.
export const STAFF_ROLES: ReviewerRole[] = ["sales-rep", "medical-reviewer"];
export type Identity = { userId: string; name: string; email: string; tenantId: string; country: string; roles: ReviewerRole[] };

// Each company's desk answers only for its own medicines. The key is the Keycloak organization alias.
export const TENANTS: Record<string, { name: string; domain: string; medicines: string[] }> = {
  pharma_a: { name: "Pharma A", domain: "pharma-a.example.com", medicines: ["CardioNex"] },
  pharma_b: { name: "Pharma B", domain: "pharma-b.example.com", medicines: ["NeuroVex"] }
};

// The doctors npm run identity:setup creates in Keycloak: two companies, two countries in each,
// so the lesson can put two desks side by side. The addresses use the reserved example.com domain.
export const SEED_USERS = [
  { email: "ana.rivera@pharma-a.example.com", firstName: "Ana", lastName: "Rivera", tenantId: "pharma_a", country: "US" },
  { email: "lukas.weber@pharma-a.example.com", firstName: "Lukas", lastName: "Weber", tenantId: "pharma_a", country: "DE" },
  { email: "chidi.okafor@pharma-b.example.com", firstName: "Chidi", lastName: "Okafor", tenantId: "pharma_b", country: "US" },
  { email: "yui.tanaka@pharma-b.example.com", firstName: "Yui", lastName: "Tanaka", tenantId: "pharma_b", country: "JP" }
] as const;

// Lesson 13. The people who approve: one medical reviewer (drafts) and one safety reviewer
// (adverse events) per company. They sign in the same way and see the inbox, not the chat.
export const SEED_REVIEWERS = [
  { email: "maya.chen@pharma-a.example.com", firstName: "Maya", lastName: "Chen", tenantId: "pharma_a", country: "US", role: "medical-reviewer" },
  { email: "omar.haddad@pharma-a.example.com", firstName: "Omar", lastName: "Haddad", tenantId: "pharma_a", country: "US", role: "safety-reviewer" },
  { email: "sofia.rossi@pharma-b.example.com", firstName: "Sofia", lastName: "Rossi", tenantId: "pharma_b", country: "US", role: "medical-reviewer" },
  { email: "kenji.mori@pharma-b.example.com", firstName: "Kenji", lastName: "Mori", tenantId: "pharma_b", country: "JP", role: "safety-reviewer" },
  // Lesson 14: two sales reps per company. One plans a step, the other approves it: nobody
  // decides an item their own request raised (lesson 13), so one rep alone could approve nothing.
  { email: "priya.nair@pharma-a.example.com", firstName: "Priya", lastName: "Nair", tenantId: "pharma_a", country: "US", role: "sales-rep" },
  { email: "lena.fischer@pharma-a.example.com", firstName: "Lena", lastName: "Fischer", tenantId: "pharma_a", country: "US", role: "sales-rep" },
  { email: "daniel.cho@pharma-b.example.com", firstName: "Daniel", lastName: "Cho", tenantId: "pharma_b", country: "US", role: "sales-rep" },
  { email: "arjun.mehta@pharma-b.example.com", firstName: "Arjun", lastName: "Mehta", tenantId: "pharma_b", country: "US", role: "sales-rep" }
] as const;

// Scripts (the dataset run, the error-analysis replays) ask as a named desk too, never as "nobody".
// They run inside the server's own code, so they pass an identity instead of signing in; the
// permission check still runs on it.
export function scriptUser(tenantId = "pharma_a", country = "US", roles: ReviewerRole[] = []): Identity {
  const id = `script-${tenantId}-${country.toLowerCase()}`;
  return { userId: id, name: "Script", email: `${id}@scripts.example.com`, tenantId, country, roles };
}

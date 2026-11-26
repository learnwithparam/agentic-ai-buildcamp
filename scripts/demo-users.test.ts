import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";
import { linksFor } from "../src/client/nav";
import { SEED_REVIEWERS, SEED_USERS, TENANTS } from "../src/server/users";

// The README's demo users table is what a learner signs in with. Each row is built here from
// users.ts and the top bar in nav.ts, so a new person, role or page fails until the table follows.
const ROLE_NAMES: Record<string, string> = {
  "medical-reviewer": "Medical reviewer",
  "safety-reviewer": "Safety reviewer",
  "sales-rep": "Sales rep",
  analyst: "Analyst"
};

export function demoUserRows(): string[] {
  const people = [
    ...SEED_USERS.map((user) => ({ ...user, roles: [] as string[], job: "Doctor" })),
    ...SEED_REVIEWERS.map((user) => ({ ...user, roles: [user.role as string], job: ROLE_NAMES[user.role]! }))
  ];
  return people.map(
    (user) =>
      `| ${user.firstName} ${user.lastName} | \`${user.email}\` | ${TENANTS[user.tenantId]!.name} | ${user.country} | ${user.job} | ${linksFor(user.roles).map((link) => link.label).join(", ")} |`
  );
}

test("the README's demo users table matches users.ts and the top bar", () => {
  const readme = readFileSync(path.resolve(import.meta.dirname, "../README.md"), "utf8");
  const rows = readme.split("\n").filter((line) => /^\| [^|]+ \| `[^`]+@[^`]+` \|/.test(line));
  assert.deepEqual(rows, demoUserRows());
});

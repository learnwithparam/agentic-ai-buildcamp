// The seeded people. Every access case in the course names one of them and says why.
// A grant is one fact: this person has this relation to this thing.
import type { TenantId } from "./brands";

export type Role =
  | "medical-affairs"
  | "field-rep"
  | "safety-officer"
  | "product-manager"
  | "approver";

export type Person = {
  name: string;
  displayName: string;
  tenant: TenantId | "brightloop";
  role: Role;
  country: string;
  clearance: number; // 1 public, 2 internal, 3 confidential
};

export type Grant = { person: string; relation: string; object: string };

export const PEOPLE: Person[] = [
  {
    name: "alice",
    displayName: "Alice Moreau",
    tenant: "pharma-a",
    role: "medical-affairs",
    country: "US",
    clearance: 2,
  },
  {
    name: "bob",
    displayName: "Bob Adeyemi",
    tenant: "pharma-b",
    role: "medical-affairs",
    country: "US",
    clearance: 2,
  },
  {
    name: "carol",
    displayName: "Carol Jensen",
    tenant: "pharma-a",
    role: "field-rep",
    country: "US",
    clearance: 1,
  },
  {
    name: "dr-reviewer",
    displayName: "Dr Mei Lin Zhao",
    tenant: "pharma-a",
    role: "safety-officer",
    country: "US",
    clearance: 3,
  },
  {
    name: "priya",
    displayName: "Priya Raman",
    tenant: "brightloop",
    role: "product-manager",
    country: "US",
    clearance: 2,
  },
  {
    name: "marcus",
    displayName: "Marcus Webb",
    tenant: "brightloop",
    role: "product-manager",
    country: "US",
    clearance: 3,
  },
  {
    name: "lena",
    displayName: "Lena Ortiz",
    tenant: "brightloop",
    role: "approver",
    country: "US",
    clearance: 3,
  },
];

// Two hops: a person covers a territory, and a territory carries a brand.
export const GRANTS: Grant[] = [
  { person: "alice", relation: "member", object: "pharma-a" },
  { person: "carol", relation: "member", object: "pharma-a" },
  { person: "dr-reviewer", relation: "member", object: "pharma-a" },
  { person: "bob", relation: "member", object: "pharma-b" },
  { person: "carol", relation: "covers", object: "Great Lakes" },
  { person: "carol", relation: "covers", object: "New England" },
  { person: "alice", relation: "covers", object: "all-territories" },
  { person: "Great Lakes", relation: "carries", object: "CardioZ" },
  { person: "Great Lakes", relation: "carries", object: "Breathe-EZ" },
  { person: "New England", relation: "carries", object: "CardioZ" },
  { person: "priya", relation: "member", object: "core-growth" },
  { person: "marcus", relation: "member", object: "enterprise-stealth" },
  { person: "lena", relation: "member", object: "core-growth" },
  { person: "lena", relation: "member", object: "enterprise-stealth" },
  { person: "lena", relation: "approves", object: "briefings" },
  { person: "dr-reviewer", relation: "approves", object: "adverse-events" },
];

export function personNamed(name: string): Person {
  const found = PEOPLE.find((person) => person.name === name);
  if (found === undefined) throw new Error(`There is no person called ${name}.`);
  return found;
}

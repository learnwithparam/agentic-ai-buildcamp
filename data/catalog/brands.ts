// Two invented drug companies, five invented brands and four countries.
// Nothing here is a real medicine. Every dose, warning and number is made up for the course.

export const AS_OF = "2026-11-20"; // "today" for every freshness rule in the course

export type TenantId = "pharma-a" | "pharma-b";
export type Country = "US" | "DE" | "JP" | "BR";

export type Brand = {
  name: string;
  tenant: TenantId;
  area: string;
  form: string;
};

export const TENANTS: { id: TenantId; name: string }[] = [
  { id: "pharma-a", name: "Northvale Therapeutics" },
  { id: "pharma-b", name: "Calder Health" },
];

export const COUNTRIES: { code: Country; name: string }[] = [
  { code: "US", name: "United States" },
  { code: "DE", name: "Germany" },
  { code: "JP", name: "Japan" },
  { code: "BR", name: "Brazil" },
];

export const BRANDS: Brand[] = [
  { name: "OncoX", tenant: "pharma-a", area: "oncology", form: "tablet" },
  { name: "CardioZ", tenant: "pharma-a", area: "cardiology", form: "tablet" },
  { name: "Breathe-EZ", tenant: "pharma-a", area: "respiratory", form: "inhaler" },
  { name: "DermaClear", tenant: "pharma-b", area: "dermatology", form: "cream" },
  { name: "NeuroCalm", tenant: "pharma-b", area: "neurology", form: "tablet" },
];

export function brandNamed(name: string): Brand {
  const found = BRANDS.find((brand) => brand.name === name);
  if (found === undefined) throw new Error(`There is no brand called ${name}.`);
  return found;
}

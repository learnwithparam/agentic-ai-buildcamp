// bun run world <name>: start a world on localhost:7700 with a fresh ledger from its seed.
import { join } from "node:path";

const name = process.argv[2];
if (name !== "freight-audit") {
  console.log(name ? `There is no world called "${name}". Worlds:` : "Name a world. Worlds:");
  console.log("  bun run world freight-audit");
  process.exit(1);
}
const port = Number(process.env.WORLD_PORT ?? 7700);
const { startWorld } = await import(join(import.meta.dir, name, "world.ts"));
const dbPath = join(import.meta.dir, "..", ".world", `${name}.sqlite`);
let world;
try {
  world = startWorld({ port, dbPath });
} catch (e) {
  if (String((e as Error).message).includes("in use") || (e as any).code === "EADDRINUSE") {
    console.log(
      `Port ${port} is in use. Another world may be running. Stop it, or start this one with WORLD_PORT=7710.`,
    );
    process.exit(2);
  }
  throw e;
}
const rows = world.ledger();
const tenants = [...new Set(rows.map((r: any) => r.tenant))];
console.log(`The freight-audit world is running on ${world.url}`);
console.log(
  `  Ledger: ${world.url}/ledger  (${rows.length} invoices, all open, tenants: ${tenants.join(", ")})`,
);
console.log(`  Tools:  POST ${world.url}/tools/<name>  and MCP at ${world.url}/mcp`);
console.log(`  Database: .world/${name}.sqlite (a fresh copy of the seed each start)`);
console.log("Leave this running. Press Ctrl+C to stop it.");

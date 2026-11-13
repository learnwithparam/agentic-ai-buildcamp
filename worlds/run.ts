// bun run world <name>: start a world on localhost:7700 with a fresh ledger from its seed.
import { join } from "node:path";
import type { World, WorldOptions } from "./freight-audit/world";

type WorldModule = { startWorld: (options: WorldOptions) => World };

const name = process.argv[2];
if (name !== "freight-audit") {
  console.log(name ? `There is no world called "${name}". Worlds:` : "Name a world. Worlds:");
  console.log("  bun run world freight-audit");
  process.exit(1);
}
const port = Number(process.env.WORLD_PORT ?? 7700);
const { startWorld }: WorldModule = await import(join(import.meta.dir, name, "world.ts"));
const dbPath = join(import.meta.dir, "..", ".world", `${name}.sqlite`);

function isPortInUse(error: unknown): boolean {
  const { message, code } = error as { message?: unknown; code?: unknown };
  return String(message).includes("in use") || code === "EADDRINUSE";
}

function startOrExplain(): World {
  try {
    return startWorld({ port, dbPath });
  } catch (error) {
    if (isPortInUse(error)) {
      console.log(
        `Port ${port} is in use. Another world may be running. ` +
          "Stop it, or start this one with WORLD_PORT=7710.",
      );
      process.exit(2);
    }
    throw error;
  }
}

const world = startOrExplain();
const invoices = world.ledger();
const tenants = [...new Set(invoices.map((invoice) => invoice.tenant))];
const ledgerSummary = `${invoices.length} invoices, all open, tenants: ${tenants.join(", ")}`;
console.log(`The freight-audit world is running on ${world.url}`);
console.log(`  Ledger: ${world.url}/ledger  (${ledgerSummary})`);
console.log(`  Tools:  POST ${world.url}/tools/<name>  and MCP at ${world.url}/mcp`);
console.log(`  Database: .world/${name}.sqlite (a fresh copy of the seed each start)`);
console.log("Leave this running. Press Ctrl+C to stop it.");

// Lesson 22. npm run bi:setup, once: the insights agent's two database logins, then the sales data.
// A volume made from lesson 22 on already has the logins (infra/postgres/init/02-bi-roles.sh); an
// older one gets them here. Only the server's owner, postgres, may make a login, so this runs that
// same script inside the container, after restarting it so it sees the passwords identity:setup wrote.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSales } from "../src/server/bi/load";
import { createPool, migrate } from "../src/server/db";
import { env } from "../src/server/env";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = ["compose", "--env-file", path.join(root, ".env"), "-f", path.join(root, "infra/docker-compose.yml")];

execFileSync("docker", [...compose, "up", "-d", "--wait", "postgres"], { stdio: "inherit" });
execFileSync("docker", [...compose, "exec", "-T", "postgres", "bash", "/docker-entrypoint-initdb.d/02-bi-roles.sh"], { stdio: "inherit" });

for (const url of [env.databaseUrl, env.testDatabaseUrl].filter(Boolean)) {
  const pool = createPool(url);
  try {
    await migrate(pool);
    const loaded = await loadSales(pool);
    console.log(`${new URL(url).pathname.slice(1)}: ${loaded.rows} vendor rows, ${loaded.published} published totals.`);
  } finally {
    await pool.end();
  }
}
console.log("Ready. Next: npm run dev, then sign in as an analyst and open /insights");

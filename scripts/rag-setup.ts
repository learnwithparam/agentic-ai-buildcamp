// Lesson 20. npm run rag:setup, once: installs pgvector in the app's two databases and starts
// Docling. A volume made from lesson 20 on already has the extension (infra/postgres/init); an
// older one gets it here. Only the server's owner, postgres, may install an extension, so this runs
// psql inside the container rather than as the app's role.
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compose = ["compose", "--env-file", path.join(root, ".env"), "-f", path.join(root, "infra/docker-compose.yml")];

for (const db of ["medinfo", "medinfo_test"]) {
  execFileSync("docker", [...compose, "exec", "-T", "postgres", "psql", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", db, "-c", "CREATE EXTENSION IF NOT EXISTS vector;"], {
    stdio: "inherit"
  });
}
console.log("Starting Docling (the first start downloads about 7 GB and loads its layout models)...");
execFileSync("docker", [...compose, "--profile", "ingest", "up", "-d", "--wait", "docling"], { stdio: "inherit" });
console.log("Ready. Next: npm run rag:ingest");

// bun run up: start the stack, build the seed files and load them into Postgres.
// A second run is safe. It starts from fresh data each time.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { closeDatabase, rows } from "../packages/core/src/db";
import { loadSeed } from "../packages/core/src/seed-load";
import { MS_PER_SECOND } from "../src/time";
import { ROOT } from "./root";
import { seed } from "./seed";

const COMPOSE_FILE = join(ROOT, "infra", "docker-compose.yml");
const PHOENIX_HEALTH = "http://localhost:6006/healthz";

export function startContainers(): void {
  const profile = process.argv.includes("--gateway") ? ["--profile", "gateway"] : [];
  const args = ["compose", "-f", COMPOSE_FILE, ...profile, "up", "-d", "--wait"];
  const run = spawnSync("docker", args, { stdio: "inherit" });
  if (run.status !== 0) throw new Error("Docker did not start the stack. Is Docker running?");
}

export async function waitForPhoenix(seconds = 60): Promise<void> {
  for (let attempt = 0; attempt < seconds; attempt++) {
    const reply = await fetch(PHOENIX_HEALTH).catch(() => undefined);
    if (reply?.ok) return;
    await Bun.sleep(MS_PER_SECOND);
  }
  throw new Error(`Phoenix did not answer at ${PHOENIX_HEALTH}.`);
}

export async function startStack(): Promise<void> {
  startContainers();
  await waitForPhoenix();
  await rows("CREATE EXTENSION IF NOT EXISTS vector");
  await seed();
  await loadSeed();
}

if (import.meta.main) {
  await startStack();
  const [people] = await rows<{ count: string }>("SELECT count(*) FROM people");
  console.log(`The stack is up. Postgres holds ${people.count} people. Phoenix is on port 6006.`);
  await closeDatabase();
}

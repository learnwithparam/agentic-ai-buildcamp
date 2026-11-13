// bun run text-audit: starts the ledger, the board and the trace viewer, opens each page in a real
// browser and runs the 10 text checks. It stops everything it started.
import { join } from "node:path";
import { ROOT } from "./structure";

const PORTS = [7700, 7701, 7703];
const STARTS = [
  ["bun", "worlds/run.ts", "freight-audit"],
  ["bun", "reference/start.ts"],
  ["bun", "parts/04-operate/operate.ts", "traces"],
];

async function isUp(port: number): Promise<boolean> {
  return fetch(`http://localhost:${port}/`).then(
    () => true,
    () => false,
  );
}

async function waitFor(port: number): Promise<boolean> {
  for (let tries = 0; tries < 60; tries++) {
    if (await isUp(port)) return true;
    await Bun.sleep(500);
  }
  return false;
}

const servers = STARTS.map((command) =>
  Bun.spawn(command, { cwd: ROOT, stdout: "ignore", stderr: "ignore" }),
);
const stop = () => {
  for (const server of servers) server.kill();
};

let exitCode = 1;
try {
  const ready = await Promise.all(PORTS.map(waitFor));
  if (ready.includes(false)) {
    console.error(
      "A page did not start. Try next: run bun run world, bun run reference-employee, " +
        "and the trace viewer by hand.",
    );
  } else {
    const install = Bun.spawnSync(["bunx", "playwright", "install", "chromium"], { cwd: ROOT });
    if (install.exitCode !== 0)
      console.error("Could not get the browser. Try next: run bunx playwright install chromium.");
    const configFile = join(ROOT, "e2e", "playwright.config.ts");
    const audit = Bun.spawnSync(
      ["bunx", "playwright", "test", "-c", configFile, "--trace", "off"],
      {
        cwd: ROOT,
        stdout: "inherit",
        stderr: "inherit",
      },
    );
    exitCode = audit.exitCode === 0 ? 0 : 1;
    if (exitCode)
      console.error(
        "The text audit found problems. Try next: fix the lines marked above, then rerun.",
      );
  }
} finally {
  stop();
}
process.exit(exitCode);

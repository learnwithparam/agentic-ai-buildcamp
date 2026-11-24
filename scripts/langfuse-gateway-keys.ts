/**
 * Turn on the Langfuse AI gateway (lesson 10).
 *
 * The gateway container already runs in langfuse/docker-compose.yml, unconfigured. It starts
 * routing once two keys are set, the same on langfuse-web and the gateway:
 *   - LANGFUSE_AI_GATEWAY_SERVICE_KEY: 32 random bytes, hex. The gateway uses it to ask
 *     Langfuse Web which connection and limits a request gets.
 *   - LANGFUSE_AI_GATEWAY_JWT_PRIVATE_KEY: a P-256 private key in PEM. Web signs what it
 *     tells the gateway with it.
 * This writes both to langfuse/.env (docker compose reads that file), restarts the stack and
 * waits for the gateway's /ready. It prints no key. Safe to run again: keys already set stay.
 *
 *   npm run langfuse:gateway-keys
 */
import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const envFile = path.join(root, "langfuse", ".env");
export const GATEWAY_URL = "http://localhost:3031";

// Compose reads a multi-line value from one line in single quotes, with \n for each newline.
export function gatewayKeyLines(existing: string): string[] {
  const has = (name: string) => new RegExp(`^${name}=.+`, "m").test(existing);
  const lines: string[] = [];
  if (!has("LANGFUSE_AI_GATEWAY_SERVICE_KEY")) {
    lines.push(`LANGFUSE_AI_GATEWAY_SERVICE_KEY=${randomBytes(32).toString("hex")}`);
  }
  if (!has("LANGFUSE_AI_GATEWAY_JWT_PRIVATE_KEY")) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const pem = privateKey.export({ type: "sec1", format: "pem" }).toString().trim();
    lines.push(`LANGFUSE_AI_GATEWAY_JWT_PRIVATE_KEY='${pem.replace(/\n/g, "\\n")}'`);
  }
  return lines;
}

async function waitForReady() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${GATEWAY_URL}/ready`, { signal: AbortSignal.timeout(2_000) });
      if (response.ok) return;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`The gateway did not report ready at ${GATEWAY_URL}/ready within two minutes. Check: docker compose -f langfuse/docker-compose.yml logs langfuse-ai-gateway`);
}

async function main() {
  const existing = existsSync(envFile) ? readFileSync(envFile, "utf8") : "";
  const lines = gatewayKeyLines(existing);
  if (lines.length) {
    const joined = existing && !existing.endsWith("\n") ? `${existing}\n` : existing;
    writeFileSync(envFile, `${joined}${lines.join("\n")}\n`, { mode: 0o600 });
    console.log(`Wrote ${lines.length} gateway key${lines.length === 1 ? "" : "s"} to langfuse/.env.`);
  } else {
    console.log("Both gateway keys are already in langfuse/.env.");
  }
  execFileSync(
    "docker",
    ["compose", "-f", "langfuse/docker-compose.yml", "-f", "langfuse/workshop.override.yml", "up", "-d", "langfuse-web", "langfuse-ai-gateway"],
    { cwd: root, stdio: ["ignore", "ignore", "inherit"] }
  );
  await waitForReady();
  console.log(`The gateway is ready at ${GATEWAY_URL}. Next: connect OpenRouter in Langfuse, under AI Gateway.`);
}

const isDirectRun = Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) await main();

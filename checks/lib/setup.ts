// The setup table for `bun run verify meet-the-world --setup`: each line passed, or the fix to try.
import { spawnSync } from "node:child_process";

type Line = { what: string; ok: boolean; optional: boolean; saw: string; fix: string };

// Whatever answers GET /health on a port, if anything does.
type HealthAnswer = { world?: string; contract?: unknown; employee?: string } | null;

async function healthOn(port: number): Promise<HealthAnswer> {
  try {
    const response = await fetch(`http://localhost:${port}/health`);
    return (await response.json()) as HealthAnswer;
  } catch {
    return null;
  }
}

function portIsFree(port: number): boolean {
  try {
    const server = Bun.serve({ port, fetch: () => new Response() });
    server.stop(true);
    return true;
  } catch {
    return false;
  }
}

// A busy port is fine when our own world or an employee is what holds it.
async function portLine(port: number, what: string): Promise<Line> {
  const line = { what: `Port ${port} free`, optional: false, fix: "" };
  if (portIsFree(port)) return { ...line, ok: true, saw: "free" };
  const health = await healthOn(port);
  if (health?.world === "freight-audit") {
    return { ...line, ok: true, saw: "the world is already running there" };
  }
  if (health?.contract) {
    return { ...line, ok: true, saw: `an employee is already running there (${health.employee})` };
  }
  return {
    ...line,
    ok: false,
    saw: "in use",
    fix: `Stop what uses port ${port} (${what}), or find it with: lsof -i :${port}`,
  };
}

// The first line a tool prints for --version, or null when the tool is missing.
function version(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) return null;
  const printed = (result.stdout || result.stderr).trim();
  return printed.split("\n")[0];
}

function bunIsNewEnough(): boolean {
  const [major, minor, patch] = Bun.version.split(".").map(Number);
  if (major !== 1) return major > 1;
  if (minor !== 4) return minor > 4;
  return patch >= 4;
}

function toolLines(): Line[] {
  const dockerVersion = version("docker", ["--version"]);
  const uvVersion = version("uv", ["--version"]);
  const hasModelKey = Boolean(process.env.ANTHROPIC_API_KEY);
  return [
    {
      what: "Bun 1.4.4 or newer",
      ok: bunIsNewEnough(),
      optional: false,
      saw: `Bun ${Bun.version}`,
      fix: "Run: bun upgrade",
    },
    {
      what: "Model key (optional)",
      ok: hasModelKey,
      optional: true,
      saw: hasModelKey ? "ANTHROPIC_API_KEY is set" : "not set",
      fix:
        "Fine for now: the reference runs on recorded replies. " +
        "Set ANTHROPIC_API_KEY before your employee calls a model",
    },
    {
      what: "Docker (optional)",
      ok: Boolean(dockerVersion),
      optional: true,
      saw: dockerVersion ?? "not found",
      fix:
        "Only needed for ship-it-as-a-service. " +
        "Install Docker Desktop or Docker Engine before then",
    },
    {
      what: "uv (Python path only)",
      ok: Boolean(uvVersion),
      optional: true,
      saw: uvVersion ?? "not found",
      fix: "Only for starter/python. Install from docs.astral.sh/uv",
    },
  ];
}

function tagFor(line: Line): string {
  if (line.ok) return "PASS";
  if (line.optional) return "SKIP";
  return "FAIL";
}

function printLines(lines: Line[]) {
  const width = Math.max(...lines.map((line) => line.what.length));
  for (const line of lines) {
    console.log(`  ${tagFor(line)}  ${line.what.padEnd(width)}  ${line.saw}`);
    if (!line.ok) console.log(`        ${" ".repeat(width)}  Fix: ${line.fix}`);
  }
}

export async function setupTable(): Promise<number> {
  const lines: Line[] = [
    ...toolLines(),
    await portLine(7700, "the world"),
    await portLine(7701, "your employee"),
    await portLine(7702, "the board"),
  ];
  console.log("Setup for the Agentic AI Buildcamp:");
  printLines(lines);
  const toFix = lines.filter((line) => !line.ok && !line.optional).length;
  if (toFix) {
    console.log(`${toFix} line(s) to fix before you start.`);
    return 1;
  }
  console.log("Ready. Next: bun run world freight-audit");
  return 0;
}

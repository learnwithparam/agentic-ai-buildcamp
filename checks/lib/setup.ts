// The setup table for `bun run verify meet-the-world --setup`: each line passed, or the fix to try.
import { spawnSync } from "node:child_process";

type Line = { what: string; ok: boolean; optional: boolean; saw: string; fix: string };

async function portLine(port: number, what: string): Promise<Line> {
  try {
    const s = Bun.serve({ port, fetch: () => new Response() });
    s.stop(true);
    return { what: `Port ${port} free`, ok: true, optional: false, saw: "free", fix: "" };
  } catch {
    const world = await fetch(`http://localhost:${port}/health`).then((r) => r.json()).catch(() => null);
    if (world?.world === "freight-audit") return { what: `Port ${port} free`, ok: true, optional: false, saw: "the world is already running there", fix: "" };
    if (world?.contract) return { what: `Port ${port} free`, ok: true, optional: false, saw: `an employee is already running there (${world.employee})`, fix: "" };
    return { what: `Port ${port} free`, ok: false, optional: false, saw: "in use", fix: `Stop what uses port ${port} (${what}), or find it with: lsof -i :${port}` };
  }
}

const version = (cmd: string, args: string[]) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  return r.status === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
};

export async function setupTable(): Promise<number> {
  const [maj, min, pat] = Bun.version.split(".").map(Number);
  const bunOk = maj > 1 || (maj === 1 && (min > 4 || (min === 4 && pat >= 4)));
  const docker = version("docker", ["--version"]);
  const uv = version("uv", ["--version"]);
  const lines: Line[] = [
    { what: "Bun 1.4.4 or newer", ok: bunOk, optional: false, saw: `Bun ${Bun.version}`, fix: "Run: bun upgrade" },
    { what: "Model key (optional)", ok: Boolean(process.env.ANTHROPIC_API_KEY), optional: true,
      saw: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY is set" : "not set", fix: "Fine for now: the reference runs on recorded replies. Set ANTHROPIC_API_KEY before your employee calls a model" },
    { what: "Docker (optional)", ok: Boolean(docker), optional: true, saw: docker ?? "not found", fix: "Only needed for ship-it-as-a-service. Install Docker Desktop or Docker Engine before then" },
    { what: "uv (Python path only)", ok: Boolean(uv), optional: true, saw: uv ?? "not found", fix: "Only for starter/python. Install from docs.astral.sh/uv" },
    await portLine(7700, "the world"),
    await portLine(7701, "your employee"),
    await portLine(7702, "the board"),
  ];
  console.log("Setup for the Agentic AI Buildcamp:");
  const w = Math.max(...lines.map((l) => l.what.length));
  for (const l of lines) {
    const tag = l.ok ? "PASS" : l.optional ? "SKIP" : "FAIL";
    console.log(`  ${tag}  ${l.what.padEnd(w)}  ${l.saw}`);
    if (!l.ok) console.log(`        ${" ".repeat(w)}  Fix: ${l.fix}`);
  }
  const bad = lines.filter((l) => !l.ok && !l.optional).length;
  console.log(bad ? `${bad} line(s) to fix before you start.` : "Ready. Next: bun run world freight-audit");
  return bad ? 1 : 0;
}

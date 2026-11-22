// A small wrapper so every script runs git the same way and stops with a clear message.
import { ROOT } from "./root";

export type GitResult = { ok: boolean; output: string };

export function git(args: string[], options: { cwd?: string; env?: Record<string, string> } = {}) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: options.cwd ?? ROOT,
    env: { ...process.env, ...options.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const output = result.stdout.toString() + result.stderr.toString();
  return { ok: result.exitCode === 0, output: output.trim() } satisfies GitResult;
}

export function mustGit(
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const result = git(args, options);
  if (!result.ok) throw new Error(`git ${args.join(" ")} failed:\n${result.output}`);
  return result.output;
}

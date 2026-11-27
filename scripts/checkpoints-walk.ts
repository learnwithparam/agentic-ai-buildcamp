// npm run walk -- checkpoint/20-rag      walk one tag
// npm run walk -- --all                   walk every tag in sync-checkpoints.sh order
//
// Proves a checkpoint tag the way a learner meets it. For each tag it makes a git worktree under
// the OS temp dir, links the caller's env file into it by path (the file is never read here),
// installs, runs `npm run setup`, starts the app, then:
//   1. asks each question in the lesson page's `walk` block through the real /api and the real
//      model (the client in scripts/demo-turns.ts) and checks the route, the sections found and
//      that the answer cites;
//   2. runs each bash block marked <!-- run --> and checks that every line of the block marked
//      <!-- output --> right after it appears in the real output, with the same numbers;
//   3. captures docs/flows/<tag>/*.json (scripts/flows-capture.ts);
//   4. stops the app and any stack it started, and removes the worktree, also on Ctrl-C.
// It then writes one row per tag to docs/checkpoint-walk.md. scripts/check-repo.ts fails when a tag
// has no row, or its row names an older commit than the tag.
//
// A walk block is a fenced block tagged `walk`, one JSON object per line:
//   { "user": "ana.rivera@pharma-a.example.com", "ask": "...", "route": "answer", "sections": ["cardionex-uspi-v2 2.2"], "cites": true }
// `user` is a demo user's email, or its first name. `sections` and `cites` are optional.
import { runMain } from "./run-main";
import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const WALK_FILE = "docs/checkpoint-walk.md";
const HEADER = "| Tag | Commit | Date | Questions | Run blocks | Traces | First failure |";
const COLUMNS = 7;

export type WalkAsk = { user: string; ask: string; route: string; sections: string[]; cites: boolean };
export type RunBlock = { line: number; command: string; quoted?: string };
export type WalkRow = { tag: string; commit: string; date: string; questions: [number, number]; runs: [number, number]; traces: string[]; failure: string };

// ---- reading the lesson page ----

const FENCE = /^```(\w*)\s*$/;

type Fence = { lang: string; start: number; body: string };

// Every fenced block with its language, the line it opens on (1-based) and its text.
function fences(text: string): Fence[] {
  const found: Fence[] = [];
  const lines = text.split("\n");
  for (let at = 0; at < lines.length; at++) {
    const open = FENCE.exec(lines[at]);
    if (!open) continue;
    const body: string[] = [];
    let end = at + 1;
    while (end < lines.length && !/^```\s*$/.test(lines[end])) body.push(lines[end++]);
    found.push({ lang: open[1], start: at + 1, body: body.join("\n") });
    at = end;
  }
  return found;
}

export function parseWalk(text: string): { asks: WalkAsk[]; errors: string[] } {
  const asks: WalkAsk[] = [];
  const errors: string[] = [];
  for (const block of fences(text).filter((fence) => fence.lang === "walk")) {
    block.body.split("\n").forEach((raw, index) => {
      if (!raw.trim()) return;
      const line = block.start + 1 + index;
      let value: unknown;
      try {
        value = JSON.parse(raw);
      } catch (error) {
        errors.push(`walk block line ${line}: not JSON (${(error as Error).message})`);
        return;
      }
      const item = value as Record<string, unknown>;
      const strings = ["user", "ask", "route"].filter((key) => typeof item?.[key] !== "string" || !(item[key] as string).trim());
      if (strings.length) return void errors.push(`walk block line ${line}: needs ${strings.join(", ")} as text`);
      const sections = item.sections ?? [];
      if (!Array.isArray(sections) || sections.some((each) => typeof each !== "string")) return void errors.push(`walk block line ${line}: sections must be a list of text`);
      if (item.cites !== undefined && typeof item.cites !== "boolean") return void errors.push(`walk block line ${line}: cites must be true or false`);
      asks.push({ user: item.user as string, ask: item.ask as string, route: item.route as string, sections: sections as string[], cites: item.cites === true });
    });
  }
  return { asks, errors };
}

// A bash block preceded by <!-- run -->, with the block after <!-- output --> that follows it, if any.
export function parseRuns(text: string): RunBlock[] {
  const lines = text.split("\n");
  const all = fences(text);
  // The fenced block that follows `marker`, which is the next non-blank line at or after `from` (0-based).
  const blockAfter = (marker: string, from: number): Fence | undefined => {
    let at = from;
    while (at < lines.length && !lines[at].trim()) at++;
    if (lines[at]?.trim() !== marker) return undefined;
    at++;
    while (at < lines.length && !lines[at].trim()) at++;
    return all.find((fence) => fence.start === at + 1);
  };
  const runs: RunBlock[] = [];
  lines.forEach((line, index) => {
    if (line.trim() !== "<!-- run -->") return;
    const command = blockAfter("<!-- run -->", index);
    if (!command || command.lang !== "bash") return;
    const commandEnd = command.start + command.body.split("\n").length + 1; // the line after the closing fence, 0-based
    const shown = blockAfter("<!-- output -->", commandEnd);
    runs.push({ line: command.start, command: command.body, quoted: shown?.body });
  });
  return runs;
}

const NUMBER = /\d+(?:\.\d+)?/g;

// Each non-blank quoted line must appear in the real output. A line that matches except for its
// numbers is reported as changed numbers, so a drift in a figure is not read as a missing line.
export function compareOutput(quoted: string, real: string): string[] {
  const actual = real.split("\n").map((line) => line.trim());
  const problems: string[] = [];
  for (const raw of quoted.split("\n")) {
    const wanted = raw.trim();
    if (!wanted || actual.some((line) => line.includes(wanted))) continue;
    const shape = wanted.replace(NUMBER, "#");
    const near = actual.find((line) => line.replace(NUMBER, "#").includes(shape));
    problems.push(near ? `numbers changed: the page quotes "${wanted}", the run printed "${near}"` : `missing: the page quotes "${wanted}", the run did not print it`);
  }
  return problems;
}

// ---- the table ----

export function formatRow(row: WalkRow): string {
  const cells = [row.tag, row.commit.slice(0, 12), row.date, `${row.questions[0]} of ${row.questions[1]}`, `${row.runs[0]} of ${row.runs[1]}`, row.traces.join(", ") || "none", row.failure || "none"];
  return `| ${cells.map((cell) => cell.replace(/\|/g, "/").replace(/\s+/g, " ")).join(" | ")} |`;
}

const tagNumber = (cells: string[]) => Number(/checkpoint\/(\d+)/.exec(cells[0] ?? "")?.[1] ?? 999);

export type StoredRow = { tag: string; commit: string };

export function parseRows(text: string): StoredRow[] {
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.trim() === HEADER);
  if (start < 0) return [];
  const rows: StoredRow[] = [];
  for (const line of lines.slice(start + 2)) {
    if (!line.startsWith("|")) break;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    rows.push({ tag: cells[0], commit: cells[1] });
  }
  return rows;
}

// Puts the row in the table, replacing the tag's older row, with the tags in lesson order.
export function writeRow(text: string | undefined, row: WalkRow): string {
  const intro = "# Checkpoint walk\n\nOne row per checkpoint tag, written by `npm run walk`. Do not edit a row by hand.\n\n";
  const kept = (text ? text.split("\n").slice(text.split("\n").findIndex((line) => line.trim() === HEADER) + 2) : []).filter((line) => line.startsWith("|"));
  const rows = kept.filter((line) => line.split("|")[1]?.trim() !== row.tag);
  rows.push(formatRow(row));
  rows.sort((a, b) => tagNumber(a.split("|").slice(1).map((cell) => cell.trim())) - tagNumber(b.split("|").slice(1).map((cell) => cell.trim())));
  return `${intro}${HEADER}\n| ${Array(COLUMNS).fill("---").join(" | ")} |\n${rows.join("\n")}\n`;
}

// The tags the sync script publishes, in order.
export function syncTags(script: string): string[] {
  return [...script.matchAll(/^\s+(checkpoint\/[\w.-]+)\s*$/gm)].map((match) => match[1]);
}

// check-repo's check. A tag the repo cannot resolve (commitOf returns undefined) is skipped: a clone
// without tags has nothing to compare. Before the file exists, "not walked yet" is a problem only on a release.
export function checkWalk(options: { text?: string; tags: string[]; commitOf: (tag: string) => string | undefined; release?: boolean }): string[] {
  if (options.text === undefined) return options.release ? [`${WALK_FILE}: not walked yet. Run npm run walk -- --all before a release.`] : [];
  const rows = new Map(parseRows(options.text).map((row) => [row.tag, row.commit]));
  const problems: string[] = [];
  for (const tag of options.tags) {
    const tip = options.commitOf(tag);
    if (!tip) continue;
    const walked = rows.get(tag);
    if (!walked) problems.push(`${WALK_FILE}: ${tag} has no row. Run npm run walk -- ${tag}.`);
    else if (!tip.startsWith(walked)) problems.push(`${WALK_FILE}: the row for ${tag} names ${walked}, the tag is at ${tip.slice(0, walked.length)}. Walk it again.`);
  }
  return problems;
}

// ---- the walk ----

const SHORT_NAMES = ["ana.rivera@pharma-a.example.com", "chidi.okafor@pharma-b.example.com"];

export function emailOf(user: string): string {
  if (user.includes("@")) return user;
  const found = SHORT_NAMES.find((email) => email.startsWith(`${user.toLowerCase()}.`));
  if (!found) throw new Error(`"${user}" is not a demo user: use an email from the README table`);
  return found;
}

type Seen = { tier: string; sections: string[]; reply: string };

export function questionMisses(want: WalkAsk, seen: Seen, cited: (reply: string) => boolean): string[] {
  const misses: string[] = [];
  if (seen.tier !== want.route) misses.push(`"${want.ask}": route was ${seen.tier}, wanted ${want.route}`);
  for (const section of want.sections) if (!seen.sections.includes(section)) misses.push(`"${want.ask}": section ${section} was not found (found ${seen.sections.join(", ") || "none"})`);
  if (want.cites && !cited(seen.reply)) misses.push(`"${want.ask}": the answer has no citation`);
  return misses;
}

const run = (command: string, args: string[], cwd: string) => execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function waitFor(url: string, child: ChildProcess, seconds: number): Promise<void> {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the app stopped at start (exit ${child.exitCode})`);
    try {
      if ((await fetch(url, { signal: AbortSignal.timeout(3000) })).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((done) => setTimeout(done, 2000));
  }
  throw new Error(`${url} did not answer within ${seconds} seconds`);
}

const cleanups: Array<() => void> = [];
let cleaning = false;
function cleanUp() {
  if (cleaning) return;
  cleaning = true;
  for (const step of cleanups.splice(0).reverse()) {
    try {
      step();
    } catch {
      // keep going: one failed step must not leave the worktree behind
    }
  }
  cleaning = false;
}

function stopTree(child: ChildProcess) {
  if (child.pid && child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
  }
}

export async function walkTag(tag: string): Promise<WalkRow> {
  const name = tag.replace("checkpoint/", "");
  const number = name.slice(0, 2);
  const commit = run("git", ["rev-parse", `${tag}^{commit}`], ROOT);
  const failures: string[] = [];
  const traces: string[] = [];
  let asked = 0;
  let right = 0;
  let ran = 0;
  let ranRight = 0;
  const work = mkdtempSync(path.join(os.tmpdir(), "walk-"));
  const tree = path.join(work, name);
  try {
    cleanups.push(() => {
      spawnSync("git", ["worktree", "remove", "--force", tree], { cwd: ROOT });
      rmSync(work, { recursive: true, force: true });
    });
    run("git", ["worktree", "add", "--detach", tree, tag], ROOT);
    const env = process.env.WALK_ENV_FILE ?? path.join(ROOT, ".env");
    if (!existsSync(env)) throw new Error(`no env file at ${env}: set WALK_ENV_FILE or create .env`);
    symlinkSync(env, path.join(tree, ".env"));
    const step = (script: string) => {
      const result = spawnSync("npm", ["run", script], { cwd: tree, encoding: "utf8" });
      if (result.status !== 0) throw new Error(`npm run ${script} failed: ${(result.stderr || result.stdout).trim().split("\n").slice(-3).join(" ")}`);
    };
    const ci = spawnSync("npm", ["ci"], { cwd: tree, encoding: "utf8" });
    if (ci.status !== 0) throw new Error(`npm ci failed: ${ci.stderr.trim().split("\n").slice(-2).join(" ")}`);
    step("setup");

    const scripts = (JSON.parse(readFileSync(path.join(tree, "package.json"), "utf8")).scripts ?? {}) as Record<string, string>;
    const app = (process.env.APP_URL ?? "http://127.0.0.1:3333").replace(/\/$/, "");
    // The stack (Postgres, Keycloak, OpenFGA) is started only when none runs, and stopped only then.
    if (scripts["infra:up"] && !run("docker", ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml", "ps", "-q"], tree)) {
      step("infra:up");
      cleanups.push(() => void spawnSync("docker", ["compose", "--env-file", ".env", "-f", "infra/docker-compose.yml", "down"], { cwd: tree }));
    }
    const child = spawn("npm", ["run", scripts.dev ? "dev" : "start"], { cwd: tree, detached: true, stdio: "ignore" });
    cleanups.push(() => stopTree(child));
    await waitFor(`${app}/api/health`, child, 180);

    const page = readdirSync(path.join(tree, "docs/learner")).find((file) => file.startsWith(`${number}-`) && file.endsWith(".md"));
    const text = page ? readFileSync(path.join(tree, "docs/learner", page), "utf8") : "";
    if (!page) failures.push(`no lesson page docs/learner/${number}-*.md on ${tag}`);

    const { asks, errors } = parseWalk(text);
    failures.push(...errors);
    if (asks.length) {
      // Imported here, not at the top: scripts/sign-in.ts reads .env when it loads.
      const { ask, newThread } = await import("./demo-turns");
      const { parseCitations } = await import("../src/server/citations");
      for (const want of asks) {
        asked++;
        try {
          const { cookie, threadId } = await newThread(emailOf(want.user));
          const seen = await ask(cookie, threadId, want.ask, 0);
          const misses = questionMisses(want, seen, (reply) => parseCitations(reply).length > 0);
          if (misses.length) failures.push(...misses);
          else right++;
        } catch (error) {
          failures.push(`"${want.ask}": ${(error as Error).message}`);
        }
      }
    }

    for (const block of parseRuns(text)) {
      ran++;
      const result = spawnSync("bash", ["-c", block.command], { cwd: tree, encoding: "utf8", timeout: 600_000 });
      const out = `${result.stdout}\n${result.stderr}`;
      const problems = result.status === 0 ? (block.quoted ? compareOutput(block.quoted, out) : []) : [`the block at line ${block.line} exited ${result.status}`];
      if (problems.length) failures.push(`run block at line ${block.line}: ${problems[0]}`);
      else ranRight++;
    }

    try {
      const { captureFlows } = await import("./flows-capture");
      for (const flow of await captureFlows(name, undefined, ROOT)) if (flow.trace) traces.push(flow.trace);
    } catch (error) {
      failures.push(`flows capture: ${(error as Error).message}`);
    }
  } catch (error) {
    failures.push((error as Error).message);
  } finally {
    cleanUp();
  }
  return { tag, commit, date: new Date().toISOString().slice(0, 10), questions: [right, asked], runs: [ranRight, ran], traces, failure: failures[0] ?? "" };
}

async function main() {
  const args = process.argv.slice(2);
  const tags = args.includes("--all") ? syncTags(readFileSync(path.join(ROOT, "scripts/sync-checkpoints.sh"), "utf8")) : args.filter((arg) => !arg.startsWith("--"));
  if (!tags.length) {
    console.error("usage: npm run walk -- checkpoint/NN-name | --all");
    process.exit(2);
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.on(signal, () => {
      cleanUp();
      process.exit(130);
    });
  let failed = 0;
  for (const tag of tags) {
    console.log(`walking ${tag}`);
    const row = await walkTag(tag);
    const file = path.join(ROOT, WALK_FILE);
    writeFileSync(file, writeRow(existsSync(file) ? readFileSync(file, "utf8") : undefined, row));
    console.log(formatRow(row));
    if (row.failure) failed++;
  }
  process.exitCode = failed ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void runMain(main, { name: "Checkpoint walk" });

// Captures the Operate part's pictures from the real pages and the real command output.
// Needs Playwright's Chromium. Run from the repo root: bun parts/04-operate/capture.ts
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startWorld, TRAPS } from "../../worlds/freight-audit/world";

const PART = import.meta.dir, ROOT = join(PART, "..", "..");
const shot = (step: string) => join(PART, step, "images", "expected.png");
const run = (args: string[], cwd = ROOT, env: Record<string, string> = {}) => new Promise<string>((res) => {
  const c = spawn("bun", args, { cwd, env: { ...process.env, ...env } });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("exit", () => res(out));
});
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 760 }, deviceScaleFactor: 2, colorScheme: "light" });

async function terminal(command: string, output: string, file: string) {
  const body = esc(output.replace(/\n+$/, "")).replace(/^(\s*)(PASS|ALLOW)/gm, '$1<span class="ok">$2</span>').replace(/^(\s*)(FAIL|REFUSE)/gm, '$1<span class="bad">$2</span>');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#e9ebe8">
    <div id="t" style="width:800px;background:#16191c;color:#d8dee4;border-radius:10px;overflow:hidden;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
      <div style="padding:9px 12px;background:#24282d;display:flex;gap:7px"><i style="width:11px;height:11px;border-radius:50%;background:#ff5f57"></i><i style="width:11px;height:11px;border-radius:50%;background:#febc2e"></i><i style="width:11px;height:11px;border-radius:50%;background:#28c840"></i></div>
      <pre style="margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-word"><span style="color:#7ee787">$</span> ${esc(command)}\n${body}</pre>
    </div><style>.ok{color:#7ee787}.bad{color:#ff7b72}</style></body></html>`);
  await page.locator("#t").screenshot({ path: file });
}

// 1. The board header: the sample clerk settles the orientation batch plus the above-rate invoice.
{
  const world = startWorld({ port: 0, dbPath: ":memory:", quiet: true });
  const tmp = mkdtempSync(join(tmpdir(), "operate-shot-"));
  const emp = spawn("bun", [join(PART, "kit-start.ts")], { cwd: tmp, env: { ...process.env, PORT: "7711", BOARD_PORT: "7712", WORLD_URL: world.url, STATE_DIR: join(tmp, "state"), TRACE_DIR: join(tmp, "traces") } });
  await Bun.sleep(1500);
  for (const id of [...TRAPS.orientation_batch, TRAPS.above_rate.invoice_id])
    await fetch("http://localhost:7711/jobs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ job_id: `shot-${id}`, tenant: "kaas-freight", trigger: { kind: "person", by: "ravi" }, input: { invoice_id: id } }) });
  await Bun.sleep(2500);
  await page.goto("http://localhost:7712/board");
  await page.waitForSelector(".card");
  await page.waitForTimeout(800);
  await page.screenshot({ path: shot("01-show-cost-per-outcome") });
  emp.kill(); world.stop(); rmSync(tmp, { recursive: true, force: true });
}

// 2. The trace viewer on the replay set.
{
  const v = spawn("bun", [join(PART, "operate.ts"), "traces"], { cwd: ROOT, env: { ...process.env, VIEWER_PORT: "7713" } });
  await Bun.sleep(2000);
  await page.goto("http://localhost:7713/");
  await page.waitForSelector(".run");
  await page.waitForTimeout(500);
  await page.screenshot({ path: shot("02-label-the-traces") });
  v.kill();
}

// 3 and 4. The gate allows fast, then refuses the planted model.
const gate = "parts/04-operate/06-run-the-swap-gate/solution";
await terminal("bun parts/04-operate/operate.ts gate parts/04-operate/06-run-the-swap-gate/problem", await run([join(PART, "operate.ts"), "gate", gate]), shot("06-run-the-swap-gate"));
await terminal("bun parts/04-operate/operate.ts gate parts/04-operate/07-refuse-a-bad-model/problem fast-misses-the-duplicate",
  await run([join(PART, "operate.ts"), "gate", "parts/04-operate/07-refuse-a-bad-model/solution", "fast-misses-the-duplicate"]), shot("07-refuse-a-bad-model"));

// 5. The scorecard: the repo copied aside, every Operate problem/ filled with its solution, then the real command.
{
  const copy = mkdtempSync(join(tmpdir(), "operate-scorecard-"));
  cpSync(ROOT, copy, { recursive: true, filter: (s) => !/\/(\.git|node_modules)(\/|$)/.test(s) });
  const part = join(copy, "parts", "04-operate");
  for (const step of readdirSync(part).filter((d) => /^\d\d-/.test(d)))
    cpSync(join(part, step, "solution"), join(part, step, "problem"), { recursive: true, filter: (s) => !s.endsWith("README.md") });
  const out = await run(["scripts/verify.ts", "part", "operate"], copy, { EMPLOYEE_DIR: join(part, "01-show-cost-per-outcome", "solution") });
  await terminal("bun run verify part operate", out, shot("09-present-on-demo-day"));
  rmSync(copy, { recursive: true, force: true });
}

await browser.close();
console.log("Captured images/expected.png for show-cost-per-outcome, label-the-traces, run-the-swap-gate, refuse-a-bad-model and present-on-demo-day.");
process.exit(0);

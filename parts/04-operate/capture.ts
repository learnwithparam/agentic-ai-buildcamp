// Captures the Operate part's pictures from the real pages and the real command output.
// Needs Playwright's Chromium. Run from the repo root: bun parts/04-operate/capture.ts
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { startWorld, TRAPS } from "../../worlds/freight-audit/world";

const PART = import.meta.dir;
const ROOT = join(PART, "..", "..");

// Where a step's picture goes: <step>/images/expected.png.
const pictureFor = (step: string) => join(PART, step, "images", "expected.png");

// Runs one bun command and returns what it printed.
function runBun(args: string[], folder = ROOT, extraEnv: Record<string, string> = {}) {
  return new Promise<string>((resolve) => {
    const child = spawn("bun", args, { cwd: folder, env: { ...process.env, ...extraEnv } });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.on("exit", () => resolve(output));
  });
}

function escapeHtml(text: string): string {
  const withoutAmpersands = text.replace(/&/g, "&amp;");
  return withoutAmpersands.replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Colours PASS, ALLOW, FAIL and REFUSE the way a terminal would.
function highlight(output: string): string {
  const html = escapeHtml(output.replace(/\n+$/, ""));
  const withPasses = html.replace(/^(\s*)(PASS|ALLOW)/gm, '$1<span class="ok">$2</span>');
  return withPasses.replace(/^(\s*)(FAIL|REFUSE)/gm, '$1<span class="bad">$2</span>');
}

const WINDOW_STYLE =
  "width:800px;background:#16191c;color:#d8dee4;border-radius:10px;overflow:hidden;" +
  "font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";
const windowDot = (colour: string) =>
  `<i style="width:11px;height:11px;border-radius:50%;background:${colour}"></i>`;
const TITLE_BAR =
  '<div style="padding:9px 12px;background:#24282d;display:flex;gap:7px">' +
  `${windowDot("#ff5f57")}${windowDot("#febc2e")}${windowDot("#28c840")}</div>`;
const PRE_STYLE = "margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-word";
const COLOURS = ".ok{color:#7ee787}.bad{color:#ff7b72}";

// A terminal window as a small HTML page, so the browser can screenshot it.
function terminalHtml(command: string, output: string): string {
  const prompt = `<span style="color:#7ee787">$</span> ${escapeHtml(command)}`;
  return (
    `<!doctype html><html><body style="margin:0;background:#e9ebe8">\n` +
    `    <div id="t" style="${WINDOW_STYLE}">\n` +
    `      ${TITLE_BAR}\n` +
    `      <pre style="${PRE_STYLE}">${prompt}\n${highlight(output)}</pre>\n` +
    `    </div><style>${COLOURS}</style></body></html>`
  );
}

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 760 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});

async function terminal(command: string, output: string, file: string) {
  await page.setContent(terminalHtml(command, output));
  await page.locator("#t").screenshot({ path: file });
}

// Asks the sample clerk to audit one invoice, as Ravi would.
function startJob(invoiceId: string) {
  return fetch("http://localhost:7711/jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      job_id: `shot-${invoiceId}`,
      tenant: "kaas-freight",
      trigger: { kind: "person", by: "ravi" },
      input: { invoice_id: invoiceId },
    }),
  });
}

// 1. The board header: the sample clerk settles the orientation batch plus the above-rate invoice.
async function captureBoard() {
  const world = startWorld({ port: 0, dbPath: ":memory:", quiet: true });
  const scratchFolder = mkdtempSync(join(tmpdir(), "operate-shot-"));
  const env: Record<string, string | undefined> = { ...process.env };
  env.PORT = "7711";
  env.BOARD_PORT = "7712";
  env.WORLD_URL = world.url;
  env.STATE_DIR = join(scratchFolder, "state");
  env.TRACE_DIR = join(scratchFolder, "traces");
  const employee = spawn("bun", [join(PART, "kit-start.ts")], { cwd: scratchFolder, env });
  await Bun.sleep(1500);
  for (const invoiceId of [...TRAPS.orientation_batch, TRAPS.above_rate.invoice_id]) {
    await startJob(invoiceId);
  }
  await Bun.sleep(2500);
  await page.goto("http://localhost:7712/board");
  await page.waitForSelector(".card");
  await page.waitForTimeout(800);
  await page.screenshot({ path: pictureFor("01-show-cost-per-outcome") });
  employee.kill();
  world.stop();
  rmSync(scratchFolder, { recursive: true, force: true });
}

// 2. The trace viewer on the replay set.
async function captureViewer() {
  const env: Record<string, string | undefined> = { ...process.env };
  env.VIEWER_PORT = "7713";
  const viewer = spawn("bun", [join(PART, "operate.ts"), "traces"], { cwd: ROOT, env });
  await Bun.sleep(2000);
  await page.goto("http://localhost:7713/");
  await page.waitForSelector(".run");
  await page.waitForTimeout(500);
  await page.screenshot({ path: pictureFor("02-label-the-traces") });
  viewer.kill();
}

// 3 and 4. The gate allows fast, then refuses the planted model.
async function captureGate() {
  const gateSolution = "parts/04-operate/06-run-the-swap-gate/solution";
  await terminal(
    "bun parts/04-operate/operate.ts gate parts/04-operate/06-run-the-swap-gate/problem",
    await runBun([join(PART, "operate.ts"), "gate", gateSolution]),
    pictureFor("06-run-the-swap-gate"),
  );
  const refuseSolution = "parts/04-operate/07-refuse-a-bad-model/solution";
  await terminal(
    "bun parts/04-operate/operate.ts gate parts/04-operate/07-refuse-a-bad-model/problem " +
      "fast-misses-the-duplicate",
    await runBun([join(PART, "operate.ts"), "gate", refuseSolution, "fast-misses-the-duplicate"]),
    pictureFor("07-refuse-a-bad-model"),
  );
}

// 5. The scorecard: the repo copied aside, every Operate problem/ filled with its solution,
// then the real command.
async function captureScorecard() {
  const copy = mkdtempSync(join(tmpdir(), "operate-scorecard-"));
  const isNotGitOrModules = (path: string) => !/\/(\.git|node_modules)(\/|$)/.test(path);
  cpSync(ROOT, copy, { recursive: true, filter: isNotGitOrModules });
  const part = join(copy, "parts", "04-operate");
  const steps = readdirSync(part).filter((folder) => /^\d\d-/.test(folder));
  for (const step of steps) {
    cpSync(join(part, step, "solution"), join(part, step, "problem"), {
      recursive: true,
      filter: (path) => !path.endsWith("README.md"),
    });
  }
  const env: Record<string, string> = {};
  env.EMPLOYEE_DIR = join(part, "01-show-cost-per-outcome", "solution");
  const output = await runBun(["scripts/verify.ts", "part", "operate"], copy, env);
  await terminal("bun run verify part operate", output, pictureFor("09-present-on-demo-day"));
  rmSync(copy, { recursive: true, force: true });
}

await captureBoard();
await captureViewer();
await captureGate();
await captureScorecard();
await browser.close();
console.log(
  "Captured images/expected.png for show-cost-per-outcome, label-the-traces, run-the-swap-gate, " +
    "refuse-a-bad-model and present-on-demo-day.",
);
process.exit(0);

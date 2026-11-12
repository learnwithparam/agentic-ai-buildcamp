// Captures every picture the READMEs show, from the real pages and the real command output.
// Needs Playwright's Chromium: bunx playwright install chromium.
// Run from the repo root: bun images/capture.ts
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startWorld } from "../worlds/freight-audit/world";

const ROOT = join(import.meta.dir, "..");
const ORIENT = join(ROOT, "00-orientation", "images");
const STEP = join(ROOT, "parts", "00-meet-the-world", "01-meet-the-world");

// The world runs in this process, so commands run without blocking it.
function runBun(args: string[]): Promise<string> {
  return new Promise<string>((resolve) => {
    const child = spawn("bun", args, { cwd: ROOT });
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

// Colours PASS, FAIL and the board's column names the way a terminal would.
function highlight(output: string): string {
  let html = escapeHtml(output.replace(/\n+$/, ""));
  html = html.replace(/^(\s*)(PASS)/gm, '$1<span class="ok">$2</span>');
  html = html.replace(/^(\s*)(FAIL)/gm, '$1<span class="bad">$2</span>');
  html = html.replace(/(NOT PAID|PAID \d+ TIMES)/g, '<span class="bad">$1</span>');
  html = html.replace(/^(\s*)(Done)(\s)/gm, '$1<span class="ok">$2</span>$3');
  html = html.replace(/^(\s*)(Needs you)/gm, '$1<span class="warn">$2</span>');
  return html.replace(/^(\s*)(Refused)/gm, '$1<span class="bad">$2</span>');
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
const COLOURS = ".ok{color:#7ee787}.bad{color:#ff7b72}.warn{color:#f2cc60}";

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

const world = startWorld({ port: 7700 });
const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1280, height: 860 },
  deviceScaleFactor: 2,
  colorScheme: "light",
});

async function terminal(command: string, output: string, file: string) {
  await page.setContent(terminalHtml(command, output));
  await page.locator("#t").screenshot({ path: file });
}

// 1. The ledger, fresh: 60 invoices, all open.
await page.goto("http://localhost:7700/ledger");
await page.waitForSelector("#rows tr");
await page.screenshot({ path: join(ORIENT, "world-ledger.png") });

// 2. The naive employee says done; the ledger disagrees.
await terminal(
  "bun run reference naive",
  await runBun(["reference/run.ts", "naive"]),
  join(ORIENT, "naive-says-done.png"),
);

// 3. The reference and its board.
const reference = spawn("bun", ["reference/run.ts"], { cwd: ROOT });
let referenceOutput = "";
await new Promise<void>((resolve) =>
  reference.stdout.on("data", (chunk) => {
    referenceOutput += chunk;
    if (referenceOutput.includes("Leave this running")) resolve();
  }),
);
await page.goto("http://localhost:7702/board");
await page.waitForSelector(".card");
await page.waitForTimeout(500);
await page.setViewportSize({ width: 1280, height: 760 });
await page.screenshot({ path: join(ORIENT, "board-orientation.png") });
copyFileSync(join(ORIENT, "board-orientation.png"), join(ROOT, "images", "board.png"));
reference.kill();
await terminal(
  "bun run reference",
  referenceOutput.split("Leave this running")[0],
  join(ROOT, "images", "reference-run.png"),
);

// 4. The step's expected result: the check passing on filled-in notes.
const notes = join(STEP, "problem", "notes.md");
const blank = readFileSync(notes, "utf8");
writeFileSync(notes, readFileSync(join(STEP, "solution", "notes.md"), "utf8"));
const verifyOutput = await runBun(["scripts/verify.ts", "meet-the-world"]);
writeFileSync(notes, blank);
await terminal("bun run verify meet-the-world", verifyOutput, join(STEP, "images", "expected.png"));

await browser.close();
world.stop();
console.log(
  "Captured: 00-orientation/images/{world-ledger,naive-says-done,board-orientation}.png, " +
    "images/{board,reference-run}.png, the step's images/expected.png",
);
process.exit(0);

// Captures every picture the READMEs show, from the real pages and the real command output.
// Needs Playwright's Chromium: bunx playwright install chromium. Run from the repo root: bun images/capture.ts
import { spawn } from "node:child_process";
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { startWorld } from "../worlds/freight-audit/world";

const ROOT = join(import.meta.dir, "..");
const ORIENT = join(ROOT, "00-orientation", "images");
const STEP = join(ROOT, "parts", "00-meet-the-world", "01-meet-the-world");
// The world runs in this process, so commands run without blocking it.
const run = (args: string[]) => new Promise<string>((res) => {
  const c = spawn("bun", args, { cwd: ROOT });
  let out = "";
  c.stdout.on("data", (d) => (out += d));
  c.on("exit", () => res(out));
});
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const world = startWorld({ port: 7700 });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2, colorScheme: "light" });

async function terminal(command: string, output: string, file: string) {
  const body = esc(output.replace(/\n+$/, "")).replace(/^(\s*)(PASS)/gm, '$1<span class="ok">$2</span>').replace(/^(\s*)(FAIL)/gm, '$1<span class="bad">$2</span>')
    .replace(/(NOT PAID|PAID \d+ TIMES)/g, '<span class="bad">$1</span>').replace(/^(\s*)(Done)(\s)/gm, '$1<span class="ok">$2</span>$3')
    .replace(/^(\s*)(Needs you)/gm, '$1<span class="warn">$2</span>').replace(/^(\s*)(Refused)/gm, '$1<span class="bad">$2</span>');
  await page.setContent(`<!doctype html><html><body style="margin:0;background:#e9ebe8">
    <div id="t" style="width:800px;background:#16191c;color:#d8dee4;border-radius:10px;overflow:hidden;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace">
      <div style="padding:9px 12px;background:#24282d;display:flex;gap:7px"><i style="width:11px;height:11px;border-radius:50%;background:#ff5f57"></i><i style="width:11px;height:11px;border-radius:50%;background:#febc2e"></i><i style="width:11px;height:11px;border-radius:50%;background:#28c840"></i></div>
      <pre style="margin:0;padding:14px 16px;white-space:pre-wrap;word-break:break-word"><span style="color:#7ee787">$</span> ${esc(command)}\n${body}</pre>
    </div><style>.ok{color:#7ee787}.bad{color:#ff7b72}.warn{color:#f2cc60}</style></body></html>`);
  await page.locator("#t").screenshot({ path: file });
}

// 1. The ledger, fresh: 60 invoices, all open.
await page.goto("http://localhost:7700/ledger");
await page.waitForSelector("#rows tr");
await page.screenshot({ path: join(ORIENT, "world-ledger.png") });

// 2. The naive employee says done; the ledger disagrees.
await terminal("bun run reference naive", await run(["reference/run.ts", "naive"]), join(ORIENT, "naive-says-done.png"));

// 3. The reference and its board.
const ref = spawn("bun", ["reference/run.ts"], { cwd: ROOT });
let refOut = "";
await new Promise<void>((res) => ref.stdout.on("data", (d) => { refOut += d; if (refOut.includes("Leave this running")) res(); }));
await page.goto("http://localhost:7702/board");
await page.waitForSelector(".card");
await page.waitForTimeout(500);
await page.setViewportSize({ width: 1280, height: 760 });
await page.screenshot({ path: join(ORIENT, "board-orientation.png") });
copyFileSync(join(ORIENT, "board-orientation.png"), join(ROOT, "images", "board.png"));
ref.kill();
await terminal("bun run reference", refOut.split("Leave this running")[0], join(ROOT, "images", "reference-run.png"));

// 4. The step's expected result: the check passing on filled-in notes.
const notes = join(STEP, "problem", "notes.md");
const blank = readFileSync(notes, "utf8");
writeFileSync(notes, readFileSync(join(STEP, "solution", "notes.md"), "utf8"));
const verify = await run(["scripts/verify.ts", "meet-the-world"]);
writeFileSync(notes, blank);
await terminal("bun run verify meet-the-world", verify, join(STEP, "images", "expected.png"));

await browser.close();
world.stop();
console.log("Captured: 00-orientation/images/{world-ledger,naive-says-done,board-orientation}.png, images/{board,reference-run}.png, the step's images/expected.png");
process.exit(0);

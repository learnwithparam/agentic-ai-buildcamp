// bun run shots: screenshot the chart page with Playwright.
// It needs a browser (bunx playwright install chromium) and a network to load the page styles.
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { chartSpec, type Row } from "../packages/core/src/surfaces";
import { chartPage } from "../packages/core/src/web";
import { ROOT } from "./root";

const ROWS: Row[] = [
  ["Southern California", 510],
  ["Texas Triangle", 472],
  ["Mid-Atlantic", 435],
];

const folder = join(ROOT, ".data", "shots");
mkdirSync(folder, { recursive: true });
const spec = chartSpec("OncoX new prescriptions", ROWS, ["Territory", "New prescriptions"]);
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  await page.setContent(chartPage("OncoX new prescriptions", spec), { waitUntil: "networkidle" });
  const file = join(folder, "web-chart.png");
  await page.screenshot({ path: file });
  console.log(`Saved ${file}`);
} finally {
  await browser.close();
}

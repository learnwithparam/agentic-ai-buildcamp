// Run with: bun scripts/shots.ts [name]
// It drives a real browser against the running web surfaces and saves one PNG per shot.
// It stops with a clear message when a surface is down. It never saves a blank image.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Page } from "playwright";
import { askQuestion, clickApproval, clickChart } from "./e2e-ui";
import { ROOT } from "./root";
import { IMAGE_DIR, SHOTS, type Shot, SURFACE_URL, type Surface, VIEWPORT } from "./shots-list";

const QUESTION = "Which territory led OncoX new prescriptions from July to September?";
const MIN_PNG_BYTES = 5_000;
const PROBE_MS = 5_000;

export function surfaceUrl(surface: Surface): string {
  const row = SURFACE_URL[surface];
  return process.env[row.env] ?? row.fallback;
}

// Fail before any browser starts when a page is not answering.
export async function checkSurfaces(shots: Shot[]): Promise<void> {
  const down: string[] = [];
  for (const surface of new Set(shots.map((shot) => shot.surface))) {
    const url = surfaceUrl(surface);
    const reply = await fetch(url, { signal: AbortSignal.timeout(PROBE_MS) }).catch(
      () => undefined,
    );
    if (reply === undefined || !reply.ok) down.push(`${surface} at ${url}`);
  }
  if (down.length > 0) {
    throw new Error(`The stack is not up. No answer from: ${down.join(", ")}. Start it first.`);
  }
}

async function doStep(page: Page, step: Shot["step"]): Promise<void> {
  if (step === "ask") await askQuestion(page, QUESTION);
  if (step === "chart") {
    await askQuestion(page, QUESTION);
    await clickChart(page);
  }
  if (step === "approval") await clickApproval(page);
}

export async function takeShot(page: Page, shot: Shot): Promise<string> {
  await page.goto(surfaceUrl(shot.surface), { waitUntil: "networkidle" });
  await doStep(page, shot.step);
  const text = ((await page.locator("body").textContent()) ?? "").trim();
  if (text === "") throw new Error(`${shot.name}: the page has no text, so it is blank.`);
  const image = await page.screenshot();
  if (image.length < MIN_PNG_BYTES) throw new Error(`${shot.name}: the image is too small.`);
  const file = join(ROOT, IMAGE_DIR, shot.name);
  writeFileSync(file, image);
  return file;
}

export async function main(only?: string): Promise<void> {
  const shots = SHOTS.filter((shot) => only === undefined || shot.name === only);
  if (shots.length === 0) throw new Error(`No shot is named ${only}.`);
  await checkSurfaces(shots);
  mkdirSync(join(ROOT, IMAGE_DIR), { recursive: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: VIEWPORT });
    for (const shot of shots) console.log(`Saved ${await takeShot(page, shot)}`);
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  await main(process.argv[2]).catch((error: Error) => {
    console.error(error.message);
    process.exit(1);
  });
}

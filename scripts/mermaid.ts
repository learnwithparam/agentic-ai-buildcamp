// bun run mermaid: every picture in the docs and the README must render.
// It renders each mermaid block with mmdc. Install it with: npm i -g @mermaid-js/mermaid-cli
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./root";
import { finish } from "./units";

// GitHub's Linux runners need Chromium without its sandbox, so mmdc reads this config.
const PUPPETEER = join(import.meta.dir, "mermaid-puppeteer.json");

export function mermaidBlocks(markdown: string): string[] {
  return [...markdown.matchAll(/^```mermaid\n([\s\S]*?)^```$/gm)].map((match) => match[1]);
}

// A Chrome that is already installed, so mmdc needs no download. CI sets the variable itself.
const MAC_CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function renderEnvironment(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  if (env.PUPPETEER_EXECUTABLE_PATH === undefined && existsSync(MAC_CHROME)) {
    env.PUPPETEER_EXECUTABLE_PATH = MAC_CHROME;
  }
  return env;
}

function firstLine(error: unknown): string {
  const text = String((error as { stderr?: Buffer }).stderr ?? (error as Error).message);
  return text.split("\n").find((line) => line.trim() !== "") ?? "render failed";
}

export function renderProblems(file: string, markdown: string): string[] {
  const folder = mkdtempSync(join(tmpdir(), "mermaid-"));
  const problems: string[] = [];
  mermaidBlocks(markdown).forEach((source, index) => {
    const input = join(folder, `block-${index + 1}.mmd`);
    writeFileSync(input, source);
    const output = join(folder, `block-${index + 1}.svg`);
    try {
      execFileSync("mmdc", ["-q", "-p", PUPPETEER, "-i", input, "-o", output], {
        stdio: "pipe",
        env: renderEnvironment(),
      });
    } catch (error) {
      problems.push(`${file}: picture ${index + 1} does not render: ${firstLine(error).trim()}`);
    }
  });
  return problems;
}

function pagesToRead(): string[] {
  const pages = ["README.md"];
  for (const folder of ["docs/modules", "docs/labs"]) {
    try {
      for (const name of readdirSync(join(ROOT, folder))) pages.push(`${folder}/${name}`);
    } catch {}
  }
  return pages.filter((page) => page.endsWith(".md"));
}

if (import.meta.main) {
  const problems = pagesToRead().flatMap((page) => {
    return renderProblems(page, readFileSync(join(ROOT, page), "utf8"));
  });
  finish(problems, "Every picture renders.", "pictures do not render.");
}

// The shot list and the docs agree: every linked image has a shot, and every shot has a page.
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { IMAGE_DIR, SHOTS, VIEWPORT } from "../scripts/shots-list";

const ROOT = join(import.meta.dir, "..");
const FIXED_VIEWPORT = { width: 1280, height: 800 };
const LINK = /!\[[^\]]*\]\(([^)\s]+)\)/g;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return markdownFiles(path);
    return path.endsWith(".md") ? [path] : [];
  });
}

function linkedImages(): { file: string; image: string }[] {
  return markdownFiles(join(ROOT, "docs")).flatMap((file) =>
    [...readFileSync(file, "utf8").matchAll(LINK)]
      .map((match) => match[1])
      .filter((target) => target.includes("images/"))
      .map((target) => ({ file, image: basename(target) })),
  );
}

describe("the screenshot list", () => {
  const names = SHOTS.map((shot) => shot.name);

  test("every image linked in docs has a shot", () => {
    for (const { file, image } of linkedImages()) {
      expect(names, `${image} in ${file}`).toContain(image);
    }
  });

  test("every shot names a doc page that exists", () => {
    for (const shot of SHOTS) expect(existsSync(join(ROOT, shot.doc)), shot.name).toBe(true);
  });

  test("names are unique PNG files", () => {
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) expect(name.endsWith(".png")).toBe(true);
  });

  test("the viewport is fixed and the folder is docs/images", () => {
    expect(VIEWPORT).toEqual(FIXED_VIEWPORT);
    expect(IMAGE_DIR).toBe("docs/images");
  });
});

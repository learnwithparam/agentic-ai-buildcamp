// Region markers: the one way a file holds both the answer and the stub a learner starts from.
//
//   // #region step:<slug>
//   ...the finished code...
//   // #stub
//   //~ // TODO(<slug>): one line saying what to write
//   //~ ...safe code so the app still runs...
//   // #endregion
//
// Main keeps the markers, and the stub lines stay comments (//~) so main still compiles.
// A checkpoint file drops the markers and keeps one half of each region. A kept stub loses its //~.
import { UNITS } from "../src/workshop";

const START = /^\s*\/\/ #region (step|lab):([a-z-]+)\s*$/;
const STUB = /^\s*\/\/ #stub\s*$/;
const END = /^\s*\/\/ #endregion\s*$/;
const STUB_LINE = /^(\s*)\/\/~ ?/;

export type Region = { kind: "step" | "lab"; slug: string; line: number };

type Mark =
  | { type: "start"; kind: Region["kind"]; slug: string }
  | { type: "stub" }
  | { type: "end" }
  | { type: "text" };

function markOf(text: string): Mark {
  const start = START.exec(text);
  if (start) return { type: "start", kind: start[1] as Region["kind"], slug: start[2] };
  if (STUB.test(text)) return { type: "stub" };
  if (END.test(text)) return { type: "end" };
  return { type: "text" };
}

type Scan = { open: Region | null; sawStub: boolean; found: Region[] };

function fail(file: string, line: number, message: string): never {
  throw new Error(`${file}:${line}: ${message}`);
}

function startRegion(scan: Scan, mark: Mark & { type: "start" }, where: string, line: number) {
  if (scan.open) fail(where, line, `region ${scan.open.slug} is not closed`);
  if (!UNITS.some((unit) => unit.slug === mark.slug)) {
    fail(where, line, `no module or lab named ${mark.slug}`);
  }
  scan.open = { kind: mark.kind, slug: mark.slug, line };
  scan.sawStub = false;
}

function endRegion(scan: Scan, where: string, line: number) {
  if (!scan.open) fail(where, line, "stray #endregion");
  if (!scan.sawStub) fail(where, line, `region ${scan.open?.slug} has no #stub`);
  scan.found.push(scan.open as Region);
  scan.open = null;
}

// Every region in a file, in order. A broken marker throws, so a typo never ships quietly.
export function regionsIn(source: string, file = "file"): Region[] {
  const scan: Scan = { open: null, sawStub: false, found: [] };
  source.split("\n").forEach((text, index) => {
    const line = index + 1;
    const mark = markOf(text);
    if (mark.type === "start") startRegion(scan, mark, file, line);
    if (mark.type === "end") endRegion(scan, file, line);
    if (mark.type === "stub") {
      if (!scan.open || scan.sawStub) fail(file, line, "stray #stub");
      scan.sawStub = true;
    }
  });
  if (scan.open) fail(file, scan.open.line, `region ${scan.open.slug} is not closed`);
  return scan.found;
}

type Position = { slug: string | null; inStub: boolean };

// Move the position along when a marker line passes by.
function advance(position: Position, mark: Mark): void {
  if (mark.type === "start") {
    position.slug = mark.slug;
    position.inStub = false;
  }
  if (mark.type === "stub") position.inStub = true;
  if (mark.type === "end") position.slug = null;
}

// Keep a text line outside regions, in a finished answer, or in an unfinished stub.
function keeps(position: Position, finished: Set<string>): boolean {
  if (position.slug === null) return true;
  return finished.has(position.slug) !== position.inStub;
}

// Render a file for a checkpoint. A region whose slug is in `finished` keeps its answer.
// Every other region keeps its stub.
export function render(source: string, finished: Set<string>, file = "file"): string {
  regionsIn(source, file);
  const out: string[] = [];
  const position: Position = { slug: null, inStub: false };
  for (const text of source.split("\n")) {
    const mark = markOf(text);
    advance(position, mark);
    if (mark.type === "text" && keeps(position, finished)) {
      out.push(position.inStub ? text.replace(STUB_LINE, "$1") : text);
    }
  }
  return out.join("\n");
}

// Which units are finished when a learner starts the given unit: everything before it.
export function finishedBefore(slug: string): Set<string> {
  const index = UNITS.findIndex((unit) => unit.slug === slug);
  if (index < 0) throw new Error(`No module or lab named ${slug}`);
  const unit = UNITS[index];
  const done = new Set<string>();
  const modules = UNITS.filter((other) => other.kind === "module");
  if (unit.kind === "module") {
    for (const earlier of modules.slice(0, modules.indexOf(unit))) done.add(earlier.slug);
    return done;
  }
  const base = modules.findIndex((other) => other.slug === unit.after);
  for (const earlier of modules.slice(0, base + 1)) done.add(earlier.slug);
  const labs = UNITS.filter((other) => other.kind === "lab");
  for (const earlier of labs.slice(0, labs.indexOf(unit))) done.add(earlier.slug);
  return done;
}

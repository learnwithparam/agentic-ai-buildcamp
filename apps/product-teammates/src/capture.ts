// The research teammate reads a rival site with Stagehand.
// It keeps a snapshot of each page and says what moved.
// A page that did not change is left alone. Every answer cites its snapshots.
// Replay reads a recorded extract file, so it needs no browser and no key.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { localBrowser, Stagehand } from "@browserbasehq/stagehand";
import { ExtractInputKind, extract } from "@xberg-io/xberg";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { z } from "zod";
import type { DocumentType } from "../../../data/catalog/documents";
import { rows } from "../../../packages/core/src/db";
import { checkClaim, groundedPrompt } from "../../../packages/core/src/grounded";
import {
  ingestDocument,
  type Outcome,
  type StoredDocument,
} from "../../../packages/core/src/ingestion";
import { OUTPUT } from "../../../scripts/seed";
import type { AgentResult } from "../../../src/grade";

export type PageName = "pricing" | "changelog";
export const PAGES: PageName[] = ["pricing", "changelog"];

const PlanSchema = z.object({ name: z.string(), priceUsd: z.number() });
const EntrySchema = z.object({ date: z.string(), title: z.string() });
export const ExtractSchema = z.object({
  rival: z.string(),
  page: z.enum(["pricing", "changelog"]),
  plans: z.array(PlanSchema).optional(),
  entries: z.array(EntrySchema).optional(),
});
export type Extracted = z.infer<typeof ExtractSchema>;

// One request to read one page. The week picks a folder of the mock site history.
export type PageRequest = { url: string; page: PageName; week: string };
export type Extractor = (request: PageRequest) => Promise<Extracted>;

const RESEARCH_FOLDER = join(import.meta.dir, "..", "research");
export const RECORDED_FILE = join(RESEARCH_FOLDER, "stagehand-extract.recorded.json");
const POLICY_FILE = join(RESEARCH_FOLDER, "router-policy.json");
export const STRATEGY_FOLDER = join(import.meta.dir, "..", "mock-site", "strategy");
const DEFAULT_MODEL = "openai/gpt-5-mini" as const;
const INSTRUCTIONS: Record<PageName, string> = {
  pricing:
    "Read every plan on this pricing page. Give each plan name and its monthly price in USD.",
  changelog: "Read every changelog entry on this page. Give each entry date and title.",
};

// The documents table has no type for a page snapshot, so the type is named here once.
const SNAPSHOT_TYPE = "snapshot" as DocumentType;
const SNAPSHOT_COUNTRY = "US";
const HASH_LENGTH = 8;
const PDF_MARGIN = 40;
const PDF_FONT_SIZE = 12;
const PDF_LINE_HEIGHT = 16;
const PDF_PAGE_WIDTH = 595;
const PDF_PAGE_HEIGHT = 842;

// Replay plays back what Stagehand returned. Each entry is one week and one page.
export function replayExtractor(file = RECORDED_FILE): Extractor {
  const recorded = JSON.parse(readFileSync(file, "utf8")) as { pages: Record<string, unknown> };
  return async ({ week, page }) => {
    const found = recorded.pages[`${week}/${page}`];
    if (found === undefined) throw new Error(`The recording has no ${page} page for ${week}.`);
    return ExtractSchema.parse(found);
  };
}

// The live reader. It opens a local browser and asks Stagehand to extract the page.
// It needs a model key. It has not run in this repo, only the replay has.
export async function liveExtractor(): Promise<{
  extractor: Extractor;
  close: () => Promise<void>;
}> {
  const browser = await localBrowser.launch({ headless: true });
  const model = { modelName: DEFAULT_MODEL, apiKey: process.env.OPENAI_API_KEY };
  const stagehand = await Stagehand.create({ browser, model });
  const tab = await stagehand.browser.context.newPage();
  // Stagehand brings its own zod copy, so its schema type does not match ours. The shape does.
  const readTab = stagehand.extract.bind(stagehand) as (
    instruction: string,
    schema: unknown,
  ) => Promise<{ data: unknown }>;
  const extractor: Extractor = async ({ url, page }) => {
    await tab.goto(`${url}/${page}`);
    const result = await readTab(INSTRUCTIONS[page], ExtractSchema);
    return ExtractSchema.parse(result.data);
  };
  return { extractor, close: () => stagehand.close() };
}

// The words a snapshot holds. One plain line for each fact, so a person can read it.
export function snapshotText(found: Extracted): string {
  const lines = [`${found.rival} ${found.page}.`];
  for (const plan of found.plans ?? []) lines.push(`${plan.name}: ${plan.priceUsd} USD per month.`);
  for (const entry of found.entries ?? []) lines.push(`${entry.date}: ${entry.title}.`);
  return lines.join(" ");
}

// Writes the text as a small PDF. The bytes repeat, so a same page gives a same hash.
export async function writeTextPdf(file: string, text: string): Promise<void> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([PDF_PAGE_WIDTH, PDF_PAGE_HEIGHT]);
  page.drawText(text, {
    x: PDF_MARGIN,
    y: PDF_PAGE_HEIGHT - PDF_MARGIN,
    size: PDF_FONT_SIZE,
    font,
    lineHeight: PDF_LINE_HEIGHT,
    maxWidth: PDF_PAGE_WIDTH - PDF_MARGIN * 2,
  });
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, await pdf.save());
}

// xberg reads a PDF into plain text.
export async function readPdfText(file: string): Promise<string> {
  const result = await extract({ kind: ExtractInputKind.Uri, uri: file });
  const text = result.results?.[0]?.content ?? "";
  return text.replace(/\s+/g, " ").trim();
}

export type Status = "first" | "unchanged" | "changed";
export type Capture = {
  rival: string;
  page: PageName;
  status: Status;
  slug: string;
  before: string; // the text of the last snapshot, or empty on a first look
  beforeSlug: string; // the name of that snapshot
  after: string;
};

function statusOf(first: boolean, outcome: Outcome): Status {
  if (first) return "first";
  return outcome === "unchanged_skipped" ? "unchanged" : "changed";
}

type Snapshot = StoredDocument & { version: number };

function brandOf(rival: string, page: PageName): string {
  return `${rival} ${page}`;
}

// The snapshots of one page, newest first.
export async function snapshotsOf(rival: string, page: PageName): Promise<Snapshot[]> {
  return rows<Snapshot>(
    `SELECT slug, brand, country, body, version FROM documents
     WHERE brand = $1 AND type = $2 ORDER BY version DESC`,
    [brandOf(rival, page), SNAPSHOT_TYPE],
  );
}

function slugOf(rival: string, page: PageName, text: string): string {
  const hash = createHash("sha256").update(text).digest("hex").slice(0, HASH_LENGTH);
  return `${rival.toLowerCase()}-${page}-${hash}`;
}

// Each plan with its price, read back from snapshot text.
export function pricesIn(text: string): Map<string, number> {
  const found = new Map<string, number>();
  for (const match of text.matchAll(/([A-Za-z]+): (\d+) USD/g))
    found.set(match[1], Number(match[2]));
  return found;
}

export type PriceMove = { plan: string; from: number; to: number };

export type Site = { url: string; week: string };
export type AskDeps = { extractor: Extractor; site: Site; day: string; generate?: Generate };

type Policy = {
  reply: string;
  rules: { route: AgentResult["route"]; why: string; words: string[] }[];
  otherwise: AgentResult["route"];
};

export type Generate = (prompt: string) => Promise<string>;

// #region lab:research-knowledge
// Every plan whose price is not the same in the two texts.
export function priceMoves(before: string, after: string): PriceMove[] {
  const old = pricesIn(before);
  const moves: PriceMove[] = [];
  for (const [plan, to] of pricesIn(after)) {
    const from = old.get(plan);
    if (from !== undefined && from !== to) moves.push({ plan, from, to });
  }
  return moves;
}

// Reads one page, keeps a snapshot and says if it moved. ingestDocument leaves a same page alone.
export async function capturePage(
  extractor: Extractor,
  request: PageRequest,
  day: string,
): Promise<Capture> {
  const found = await extractor(request);
  const text = snapshotText(found);
  const slug = slugOf(found.rival, found.page, text);
  const file = join(OUTPUT, "documents", `${slug}.pdf`);
  if (!existsSync(file)) await writeTextPdf(file, text);
  const seen = await snapshotsOf(found.rival, found.page);
  const last = seen[0];
  const same = seen.find((item) => item.slug === slug);
  const document = {
    slug,
    brand: brandOf(found.rival, found.page),
    country: SNAPSHOT_COUNTRY,
    type: SNAPSHOT_TYPE,
    version: same?.version ?? (last?.version ?? 0) + 1,
    effective: day,
    title: `${found.rival} ${found.page} on ${day}`,
    facts: {},
    body: text,
  } as const;
  const outcome = await ingestDocument(document);
  const status = statusOf(last === undefined, outcome);
  const before = last?.body ?? "";
  const beforeSlug = last?.slug ?? "";
  return { rival: found.rival, page: found.page, status, slug, before, beforeSlug, after: text };
}

// Reads both pages of the rival.
export async function captureRival(
  extractor: Extractor,
  site: Site,
  day: string,
): Promise<Capture[]> {
  const captures: Capture[] = [];
  for (const page of PAGES) {
    captures.push(await capturePage(extractor, { ...site, page }, day));
  }
  return captures;
}

export function loadPolicy(file = POLICY_FILE): Policy {
  return JSON.parse(readFileSync(file, "utf8")) as Policy;
}

// The product manager owns the word list. A question with none of the words is trivia.
export function routeByPolicy(question: string, policy = loadPolicy()): AgentResult["route"] {
  const words: string[] = question.toLowerCase().match(/[a-z]+/g) ?? [];
  for (const rule of policy.rules) {
    if (rule.words.some((word) => words.includes(word))) return rule.route;
  }
  return policy.otherwise;
}

// The replay writer. It says the price move in one sentence and cites both snapshots.
export function replayGenerate(captures: Capture[]): Generate {
  return async () => {
    const pricing = captures.find((item) => item.page === "pricing");
    if (pricing === undefined) return "NOT_IN_DOCUMENTS";
    const moves = priceMoves(pricing.before, pricing.after);
    if (pricing.status === "first") return `${pricing.after} [${pricing.slug}]`;
    if (moves.length === 0) return `${pricing.rival} did not change its prices. [${pricing.slug}]`;
    const said = moves.map((move) => `${move.plan} went from ${move.from} to ${move.to} USD`);
    const cites = `[${pricing.beforeSlug}] [${pricing.slug}]`;
    return `${pricing.rival}: ${said.join(". ")} a month. ${cites}`;
  };
}

function asDocument(snapshot: Snapshot): StoredDocument {
  const { slug, brand, country, body } = snapshot;
  return { slug, brand, country, body };
}

// Answers a question about a rival. Trivia gets the policy reply and no page is read.
// The writer sends a claim. The claim must cite a snapshot it was shown and use only its numbers.
export async function askResearch(question: string, deps: AskDeps): Promise<AgentResult> {
  const policy = loadPolicy();
  const route = routeByPolicy(question, policy);
  if (route !== "answer") return { route, text: policy.reply, citations: [] };
  const captures = await captureRival(deps.extractor, deps.site, deps.day);
  const generate = deps.generate ?? replayGenerate(captures);
  const pricing = captures.find((item) => item.page === "pricing");
  if (pricing === undefined) return { route: "refuse", text: "No page was read.", citations: [] };
  const seen = (await snapshotsOf(pricing.rival, "pricing")).slice(0, 2).map(asDocument);
  const reply = (await generate(groundedPrompt(question, seen))).trim();
  const problem = checkClaim(reply, seen);
  if (problem !== undefined) {
    return { route: "refuse", text: `I cannot give that answer: ${problem}.`, citations: [] };
  }
  const citations = [...reply.matchAll(/\[([a-z0-9-]+)\]/g)].map((match) => match[1]);
  return { route: "answer", text: reply, citations };
}

// A strategy brief is a PDF. xberg reads it, and the text is the only thing the answer may use.
export async function readStrategy(file: string): Promise<string> {
  return readPdfText(file);
}
// #stub
//~ // TODO(research-knowledge): capture each page, skip a same page, route by policy, cite it
//~ export function priceMoves(_before: string, _after: string): PriceMove[] {
//~   return [];
//~ }
//~
//~ export async function capturePage(
//~   extractor: Extractor,
//~   request: PageRequest,
//~   _day: string,
//~ ): Promise<Capture> {
//~   const found = await extractor(request);
//~   const text = snapshotText(found);
//~   const blank = { status: "first" as Status, slug: "", before: "", beforeSlug: "" };
//~   return { rival: found.rival, page: found.page, after: text, ...blank };
//~ }
//~
//~ export async function captureRival(
//~   _extractor: Extractor,
//~   _site: Site,
//~   _day: string,
//~ ): Promise<Capture[]> {
//~   return [];
//~ }
//~
//~ export function loadPolicy(_file = POLICY_FILE): Policy {
//~   return { reply: "", rules: [], otherwise: "answer" };
//~ }
//~
//~ export function routeByPolicy(_question: string, _policy = loadPolicy()): AgentResult["route"] {
//~   return "answer";
//~ }
//~
//~ export function replayGenerate(_captures: Capture[]): Generate {
//~   return async () => "";
//~ }
//~
//~ export async function askResearch(
//~   _question: string,
//~   _deps: AskDeps,
//~ ): Promise<AgentResult> {
//~   return { route: "answer", text: "Not built yet.", citations: [] };
//~ }
//~
//~ export async function readStrategy(_file: string): Promise<string> {
//~   return "";
//~ }
// #endregion

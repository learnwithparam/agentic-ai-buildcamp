// The research teammate. It reads a rival page, keeps a snapshot, and says what moved.
// A page that has not changed is left alone, so nobody reads the same news twice.
import { createHash } from "node:crypto";
import { rows } from "../../../packages/core/src/db";

export type Status = "first" | "unchanged" | "changed";
export type Watch = { rival: string; status: Status; before: string; after: string };

const TABLE = `CREATE TABLE IF NOT EXISTS rival_snapshots (id serial PRIMARY KEY, rival text,
  text text, hash text, taken timestamptz DEFAULT clock_timestamp())`;

export async function resetSnapshots(): Promise<void> {
  await rows("DROP TABLE IF EXISTS rival_snapshots");
  await rows(TABLE);
}

async function lastSnapshot(rival: string): Promise<{ text: string; hash: string } | undefined> {
  await rows(TABLE);
  const found = await rows<{ text: string; hash: string }>(
    "SELECT text, hash FROM rival_snapshots WHERE rival = $1 ORDER BY id DESC LIMIT 1",
    [rival],
  );
  return found[0];
}

async function saveSnapshot(rival: string, text: string): Promise<void> {
  const hash = createHash("sha256").update(text).digest("hex");
  await rows("INSERT INTO rival_snapshots (rival, text, hash) VALUES ($1, $2, $3)", [
    rival,
    text,
    hash,
  ]);
}

// #region lab:research-knowledge
const NOISE = [
  /<script[\s\S]*?<\/script>/gi,
  /<style[\s\S]*?<\/style>/gi,
  /<div id="cookie-banner">[\s\S]*?<\/div>/gi,
];

// Keeps the words a person would read. A closed tab still counts, a cookie banner does not.
export function readPage(html: string): string {
  let text = html;
  for (const noise of NOISE) text = text.replace(noise, " ");
  text = text.replace(/<[^>]+>/g, " ");
  return text.replace(/\s+/g, " ").trim();
}

export async function watchRival(rival: string, html: string): Promise<Watch> {
  const after = readPage(html);
  const last = await lastSnapshot(rival);
  if (last === undefined) {
    await saveSnapshot(rival, after);
    return { rival, status: "first", before: "", after };
  }
  const hash = createHash("sha256").update(after).digest("hex");
  if (hash === last.hash) return { rival, status: "unchanged", before: last.text, after };
  await saveSnapshot(rival, after);
  return { rival, status: "changed", before: last.text, after };
}

export function reportOn(watch: Watch): string {
  if (watch.status === "first") return `${watch.rival}: first look saved. It says: ${watch.after}`;
  if (watch.status === "unchanged") return `${watch.rival} did not change.`;
  return `${watch.rival} changed. Before: ${watch.before} Now: ${watch.after}`;
}
// #stub
//~ // TODO(research-knowledge): clean the page, compare it with the last snapshot, report the move
//~ export function readPage(html: string): string {
//~   return html;
//~ }
//~
//~ export async function watchRival(rival: string, html: string): Promise<Watch> {
//~   return { rival, status: "first", before: "", after: html };
//~ }
//~
//~ export function reportOn(_watch: Watch): string {
//~   return "Not built yet.";
//~ }
// #endregion

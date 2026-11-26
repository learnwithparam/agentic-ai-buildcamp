// Lesson 13. Patient identifiers leave the doctor's message before anything else reads it: the
// model, the trace, the checkpoint in Postgres and the reviewer inbox all get the scrubbed text.
// A rule in code, not a line in the prompt, because a prompt can be talked out of it.
//
// Two steps find identifiers:
//   1. Rules (this file). Shapes (record numbers, emails, phones, ID numbers), dates near "born"
//      or "DOB", street addresses with a postcode, and names that follow a title ("Mrs"), a cue
//      ("my patient", "her husband") or sit next to another identifier ("Hanna Keller, DOB ...").
//   2. One model call (phi.model.ts) for the names and addresses the rules miss. It returns the
//      exact words it found, and findOnly() keeps a word only when it is in the text.
//
// A PhiVault turns each identifier into a stable placeholder for one conversation ([PATIENT_1],
// [DOB_1]) and keeps the map. The map stays in the server's memory: it is never written to a
// trace, a checkpoint or the inbox, and restore() puts the originals back into what the doctor reads.

export type PhiType = "name" | "dob" | "address" | "mrn" | "phone" | "email" | "national_id";
export type PhiSpan = { start: number; end: number; type: PhiType; text: string };

export const PHI_TYPES: readonly PhiType[] = ["name", "dob", "address", "mrn", "phone", "email", "national_id"];

// --- Finding identifiers by rule ----------------------------------------------------------------

const MONTH =
  "(?:Jan(?:uary|uar)?|Feb(?:ruary|ruar)?|Mar(?:ch)?|M[äa]rz|Apr(?:il)?|May|Mai|Jun(?:e|i)?|Jul(?:y|i)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Okt(?:ober)?|Nov(?:ember)?|Dec(?:ember)?|Dez(?:ember)?)";
const DATES = [
  /(?<![\d/.-])\d{4}-\d{1,2}-\d{1,2}(?![\d-])/g,
  /(?<![\d/.-])\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}(?![\d/-])/g,
  /\d{4}年\d{1,2}月\d{1,2}日/g,
  new RegExp(`(?<![\\w])\\d{1,2}(?:st|nd|rd|th)?\\.?\\s+${MONTH}\\.?,?\\s+\\d{4}(?!\\d)`, "g"),
  new RegExp(`(?<![\\w])${MONTH}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}(?!\\d)`, "g")
];
const BORN_CUE = /(?:\bDOB|\bD\.O\.B\.?|\bborn(?:\s+on)?|\bb\.|\bgeboren(?:\s+am)?|\bn[ée]e?(?:\s+le)?|date of birth|birth ?date|birthday|naissance|\bnacid[oa](?:\s+el)?)[\s:,(]*$/i;
// A date after one of these is when something happened, not when the patient was born.
const EVENT_WORD = /(?:\b(?:on|since|from|until|till|before|after|by|dated|during|ab|seit|am|vom|bis|le|el|started|admitted|stopped|took)|\bdate of)[\s:,(]*$/i;
const NO_CUE_LATEST_YEAR = 2024; // two years before TODAY (labels.ts): a date this old with no event word is read as a birth date

function dateIsPlausible(value: string): boolean {
  const numbers = value.match(/\d+/g)?.map(Number) ?? [];
  if (/年/.test(value)) return numbers.length === 3 && numbers[1]! <= 12 && numbers[2]! <= 31;
  if (numbers.length !== 3) return true; // a written month: the regex already named it
  const [a, b, c] = numbers as [number, number, number];
  if (String(a).length === 4 || value.startsWith(String(a).padStart(4, "0"))) return b <= 12 && c <= 31; // year first
  return a <= 31 && b <= 31 && (a <= 12 || b <= 12);
}

function yearOf(value: string): number | undefined {
  const year = value.match(/\b\d{4}\b/)?.[0];
  return year ? Number(year) : undefined;
}

function dobSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  for (const pattern of DATES) {
    for (const match of text.matchAll(pattern)) {
      const value = match[0];
      const start = match.index!;
      if (!dateIsPlausible(value)) continue;
      const before = text.slice(Math.max(0, start - 24), start);
      const cued = BORN_CUE.test(before);
      if (!cued) {
        // Without a cue a date is a birth date only with a whole four-digit year, old enough, and no event word before it.
        const year = yearOf(value);
        if (year === undefined || year < 1900 || year > NO_CUE_LATEST_YEAR || EVENT_WORD.test(before)) continue;
      }
      out.push({ start, end: start + value.length, type: "dob", text: value });
    }
  }
  return out;
}

const RECORD_CUE =
  "(?:MRN|M\\.R\\.N\\.?|medical record (?:number|no\\.?)|record (?:number|no\\.?)|chart (?:number|no\\.?)|patient(?:'s)? (?:number|no\\.?|ID)|Patientennummer)";
const RECORD_VALUE = "(?:[A-Z]{1,3}\\s\\d[A-Z0-9-]*|(?=[A-Z0-9-]*\\d)[A-Z0-9][A-Z0-9-]*)";

function mrnSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  const cued = new RegExp(`\\b${RECORD_CUE}\\s*[:#-]?\\s*(?:is\\s+)?(${RECORD_VALUE})`, "gid");
  for (const match of text.matchAll(cued)) {
    const [start, end] = match.indices![1]!;
    out.push({ start, end, type: "mrn", text: text.slice(start, end) });
  }
  // A record number in a list with no label: two or three capitals, a hyphen, three or more digits (HV-2209).
  // HCP-1001 has that shape too, but it is the desk's own id for a doctor in its CRM (readHcpId in
  // content/outreach.ts), and removing it left the sweep unable to name any doctor.
  for (const match of text.matchAll(/(?<![\w-])(?!HCP-\d{4}(?![\w-]))[A-Z]{2,3}-\d{3,}(?:-\d+)?(?![\w-])/g)) {
    out.push({ start: match.index!, end: match.index! + match[0].length, type: "mrn", text: match[0] });
  }
  return out;
}

function nationalIdSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  const shapes = [/(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/g, /(?<![\w])[A-Z]\d{9}(?!\w)/g, /(?<![\d])\d{13}(?!\d)/g, /(?<![\d])\d{2} \d{3} \d{3} \d{3}(?!\d)/g, /(?<![\d])\d{4} \d{4} \d{4}(?!\d)/g, /(?<![\d])\d{2} \d{6} [A-Z] \d{3}(?!\d)/g];
  for (const shape of shapes) {
    for (const match of text.matchAll(shape)) out.push({ start: match.index!, end: match.index! + match[0].length, type: "national_id", text: match[0] });
  }
  const cued = /\b(?:national (?:id|insurance)(?: number)?|insurance (?:number|no\.?)|SSN|social security(?: number)?|passport(?: number)?|NHS number|tax ID|Steuer-?ID)\W{0,6}((?=[A-Z0-9 -]*\d)[A-Z0-9][A-Z0-9 -]{4,18}[A-Z0-9])/gid;
  for (const match of text.matchAll(cued)) {
    const [start, end] = match.indices![1]!;
    out.push({ start, end, type: "national_id", text: text.slice(start, end) });
  }
  return out;
}

function emailSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  // "Dr Chen ... chen.family@..." : an address that starts with the sender's own surname is the sender's, not a patient's.
  const senders = [...text.matchAll(/\bDr\.?\s+(\p{Lu}[\p{L}'’-]{2,})/gu)].map((match) => match[1]!.toLowerCase());
  for (const match of text.matchAll(/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g)) {
    const first = match[0].split("@")[0]!.split(/[._+-]/)[0]!.toLowerCase();
    if (senders.includes(first)) continue;
    out.push({ start: match.index!, end: match.index! + match[0].length, type: "email", text: match[0] });
  }
  return out;
}

const PHONE_CUE = /(?:phone|tel\.?|telefon|call(?:ed)?|number|mobile|cell|contact|reach|fax|rufen|unter)\W{0,14}$/i;
const PHONE_SHAPE = /(?<![\w+(.-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,4}\)[\s.-]?)?\d{1,5}(?:[\s.-]\d{1,8}){1,5}(?![\w-])/g;

function phoneSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  for (const match of text.matchAll(PHONE_SHAPE)) {
    const value = match[0].replace(/[\s.-]+$/, "");
    const digits = value.replace(/\D/g, "").length;
    if (digits < 9 || digits > 15) continue;
    const start = match.index!;
    const marked = /^[+(]/.test(value) || /^0/.test(value) || /^\d{3}[\s.-]\d{3}[\s.-]\d{4}$/.test(value);
    if (!marked && !PHONE_CUE.test(text.slice(Math.max(0, start - 30), start))) continue;
    out.push({ start, end: start + value.length, type: "phone", text: value });
  }
  return out;
}

// --- Street addresses ---------------------------------------------------------------------------
// A run of capitalised words and numbers ("Flat 2B, 8 Canal Street, Manchester M1 3HE") is an
// address when it holds a house number and a postcode. "4 Water Lane" alone is a clinic's.
const PARTICLE = "(?:das|de|do|da|dos|der|den|des|del|am|an|la|le|van|von|zur|auf|im)";
const ADDRESS_TOKEN = "(?:\\p{Lu}[\\p{L}\\d'’/-]*|\\d[\\p{L}\\d/-]*|No\\.)";
const ADDRESS_RUN = new RegExp(`${ADDRESS_TOKEN}(?:,?[ \\t]+(?:${ADDRESS_TOKEN}|${PARTICLE}))+`, "gu");
const POSTCODES = [/\b[A-Z]{1,2}\d[A-Z\d]?\s?\d[A-Z]{2}\b/, /\b[A-Z]{2}\s\d{5}\b/, /\b\d{4}\s?[A-Z]{2}\b/, /\b\d{4}-\d{3}\b/, /\b\d{3}\s\d{2}\b/, /\b\d{5,6}\b/, /\b\d{4}\b/];
const NOT_ADDRESS_START = new Set(["His", "Her", "My", "The", "Their", "Our", "She", "He", "They", "Lives", "Address", "Home", "At", "In", "On", "Dr", "Mr", "Mrs", "Ms"]);

function addressSpans(text: string): PhiSpan[] {
  const out: PhiSpan[] = [];
  for (const match of text.matchAll(ADDRESS_RUN)) {
    let start = match.index!;
    let run = match[0];
    for (;;) {
      const first = run.split(/[\s,]+/)[0]!;
      if (!NOT_ADDRESS_START.has(first)) break;
      const cut = run.indexOf(first) + first.length;
      const rest = run.slice(cut).replace(/^[,\s]+/, "");
      start += run.length - rest.length;
      run = rest;
    }
    // Leading words with no number ("Alvarez,") are not the street. An address names at least two things (street and place).
    for (;;) {
      const segment = run.split(",")[0]!;
      if (/\d/.test(segment) || run.indexOf(",") < 0) break;
      const rest = run.slice(segment.length + 1).replace(/^\s+/, "");
      if (!/\d/.test(rest.split(",")[0]!)) break;
      start += run.length - rest.length;
      run = rest;
    }
    if ((run.match(/(?<![\p{L}\d])\p{Lu}[\p{L}'’-]+/gu) ?? []).length < 2) continue;
    const postcode = POSTCODES.map((shape) => shape.exec(run)).find((hit) => hit && !/^(?:19|20)\d\d$/.test(hit[0]));
    if (!postcode) continue;
    const houses = [...run.matchAll(/(?<![\w-])\d{1,4}[A-Za-z]?(?![\w-])/g)].filter((hit) => hit.index! < postcode.index! || hit.index! >= postcode.index! + postcode[0].length);
    if (!houses.length) continue;
    // The address ends at its last word that belongs to it: trailing words before a comma stay.
    out.push({ start, end: start + run.length, type: "address", text: run });
  }
  for (const match of text.matchAll(/[一-鿿]{1,6}[都道府県][一-鿿]{1,8}[市区町村郡][一-鿿\d\-ー丁目番地号]{1,20}/g)) {
    out.push({ start: match.index!, end: match.index! + match[0].length, type: "address", text: match[0] });
  }
  return out;
}

// --- Names ----------------------------------------------------------------------------------------
const TITLE = "(?:Mr|Mrs|Ms|Miss|Mme|Mlle|Mx|Herr|Frau|Madame|Monsieur|Señor|Señora|Sra)\\.?";
const NAME_TOKEN = "(?:\\p{Lu}\\.(?:\\s?\\p{Lu}\\.)*|\\p{Lu}[\\p{L}'’-]+)";
const NAME_PARTICLE = "(?:van|der|den|de|da|do|dos|di|del|von|bin|ben|al|el|le|la|du|ten|ter)";
const NAME = `${NAME_TOKEN}(?:\\s+(?:${NAME_PARTICLE}\\s+)*${NAME_TOKEN}){0,4}`;
const TITLE_WORDS = new Set(["Mr", "Mrs", "Ms", "Miss", "Mme", "Mlle", "Mx", "Herr", "Frau", "Madame", "Monsieur", "Señor", "Señora", "Sra"]);
const NOT_A_NAME = new Set([
  "The", "An", "He", "She", "His", "Her", "It", "They", "Their", "We", "My", "Our", "Who", "What", "When", "Where", "Which", "Is", "Was", "Has", "Had",
  "Have", "On", "In", "At", "Of", "To", "And", "But", "If", "As", "Please", "Can", "Could", "Would", "Should", "Does", "Did", "Not", "No", "Yes",
  "With", "Without", "For", "From", "After", "Before", "Since", "Section", "Table", "Dr", "Patient", "Initials"
]);

function ci(word: string): string {
  return word.replace(/[a-z]/gi, (letter) => `[${letter.toLowerCase()}${letter.toUpperCase()}]`);
}

// What makes a capitalised word a name here, not a drug (CardioNex), a trial (CLARION-HF) or a sentence opener.
function nameLike(token: string): boolean {
  if (NOT_A_NAME.has(token)) return false;
  if (/^\p{Lu}\.(?:\s?\p{Lu}\.)*$/u.test(token)) return true;
  if (/^\p{Lu}{2,}(?:-\p{Lu}+)*$/u.test(token)) return false; // CLARION-HF, MRN
  if (/\p{Ll}\p{Lu}/u.test(token) && !/^(?:Mc|Mac|De|Di|Le|La|Van|Von|Al|El)\p{Lu}/u.test(token)) return false; // CardioNex
  return true;
}

// Cuts a matched name down to the words that are a name: no title, no sentence opener in front.
function trimName(text: string, start: number, end: number): { start: number; end: number } | null {
  let value = text.slice(start, end);
  let offset = start;
  for (;;) {
    const first = value.split(/\s+/)[0]!;
    if (!(TITLE_WORDS.has(first.replace(/\.$/, "")) || NOT_A_NAME.has(first))) break;
    const rest = value.slice(first.length).replace(/^\s+/, "");
    offset += value.length - rest.length;
    value = rest;
    if (!value) return null;
  }
  const possessive = /['’]s$/.exec(value);
  if (possessive) value = value.slice(0, possessive.index);
  const tokens = value.match(new RegExp(NAME_TOKEN, "gu")) ?? [];
  if (!tokens.length || !tokens.every(nameLike)) return null;
  return { start: offset, end: offset + value.length };
}

function nameSpans(text: string, claimed: PhiSpan[]): PhiSpan[] {
  const out: PhiSpan[] = [];
  const add = (start: number, end: number) => {
    const cut = trimName(text, start, end);
    if (cut) out.push({ start: cut.start, end: cut.end, type: "name", text: text.slice(cut.start, cut.end) });
  };
  const cues = [
    new RegExp(`(?<![\\p{L}])${TITLE}\\s+(${NAME})`, "gud"),
    new RegExp(`\\b(?:${ci("patient")}|${ci("patientin")}|${ci("patiente")}|${ci("paciente")}|[Ii]nitials)(?:\\s+is|,)?\\s+(${NAME})`, "gud"),
    new RegExp(`\\b(?:${["husband", "wife", "son", "daughter", "mother", "father", "brother", "sister", "partner", "spouse", "caregiver", "guardian"].map(ci).join("|")})(?:\\s+(?:is|was)|,)?\\s+(${NAME})`, "gud"),
    new RegExp(`\\b(?:${ci("name")}\\s+(?:is|as|was)|${ci("named")})\\s+(${NAME})`, "gud")
  ];
  for (const cue of cues) {
    for (const match of text.matchAll(cue)) add(...(match.indices![1]! as [number, number]));
  }
  // A name next to another identifier: "Hanna Keller, DOB ...", "Aisha Khan called (713) ...".
  const starts = new Set(claimed.map((span) => span.start));
  for (const match of text.matchAll(new RegExp(NAME, "gu"))) {
    const end = match.index! + match[0].length;
    const after = /^(?:\s*[,(]\s*|\s+(?:called\s+)?)/.exec(text.slice(end))?.[0];
    if (after === undefined) continue;
    const next = end + after.length;
    const cue = /^(?:born|DOB|geboren|MRN|n[ée]e? le)\b/i.test(text.slice(next));
    if (!starts.has(next) && !cue) continue;
    const tokens = match[0].match(new RegExp(NAME_TOKEN, "gu")) ?? [];
    const cut = trimName(text, match.index!, end);
    if (cut && (tokens.length >= 2 || /\.$/.test(tokens[0] ?? ""))) out.push({ start: cut.start, end: cut.end, type: "name", text: text.slice(cut.start, cut.end) });
  }
  return out;
}

// --- Putting it together ---------------------------------------------------------------------------
const PLACEHOLDER = /\[(?:PATIENT|DOB|ADDRESS|MRN|PHONE|EMAIL|ID)_\d+\]/g;

function mask(text: string, spans: PhiSpan[]): string {
  let out = text;
  for (const span of spans) out = out.slice(0, span.start) + "\u0000".repeat(span.end - span.start) + out.slice(span.end);
  return out;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

// Every identifier the rules find, in text order, none overlapping. A placeholder already in the text is left alone.
export function findSpans(text: string): PhiSpan[] {
  const accepted: PhiSpan[] = [];
  const take = (found: PhiSpan[]) => {
    for (const span of found.sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (span.text.trim() && !accepted.some((other) => overlaps(span, other))) accepted.push(span);
    }
  };
  const current = () => mask(text, [...accepted, ...[...text.matchAll(PLACEHOLDER)].map((hit) => ({ start: hit.index!, end: hit.index! + hit[0].length, type: "name" as const, text: hit[0] }))]);
  take(emailSpans(current()));
  take(nationalIdSpans(current()));
  take(mrnSpans(current()));
  take(dobSpans(current()));
  take(phoneSpans(current()));
  take(addressSpans(current()));
  take(nameSpans(current(), accepted));
  return accepted.sort((a, b) => a.start - b.start);
}

// The words a model proposed, kept only when they are in the text and are not placeholders or the whole message.
// A model's word offsets are unreliable, so it returns the words and this finds them.
export function findOnly(text: string, proposed: Array<{ text: string; type: PhiType }>): PhiSpan[] {
  const out: PhiSpan[] = [];
  const hidden = mask(text, [...text.matchAll(PLACEHOLDER)].map((hit) => ({ start: hit.index!, end: hit.index! + hit[0].length, type: "name" as const, text: hit[0] })));
  for (const item of proposed) {
    const word = item.text.trim();
    if (word.length < 2 || word.length > 120 || word === text.trim() || !PHI_TYPES.includes(item.type)) continue;
    for (let from = hidden.indexOf(word); from >= 0; from = hidden.indexOf(word, from + word.length)) {
      const span = { start: from, end: from + word.length, type: item.type, text: word };
      if (!out.some((other) => overlaps(span, other))) out.push(span);
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

// --- The vault: one conversation's map between identifiers and placeholders ---------------------
const TAG: Record<PhiType, string> = { name: "PATIENT", dob: "DOB", address: "ADDRESS", mrn: "MRN", phone: "PHONE", email: "EMAIL", national_id: "ID" };
export type VaultEntry = { type: PhiType; placeholder: string; original: string };

const normal = (value: string) => value.toLowerCase().replace(/\s+/g, " ").trim();

export class PhiVault {
  private readonly entries = new Map<string, VaultEntry>();
  private readonly counts = new Map<PhiType, number>();

  // The same identifier gets the same placeholder every time it is seen in this conversation.
  placeholderFor(type: PhiType, original: string): string {
    const key = `${type}:${normal(original)}`;
    const known = this.entries.get(key);
    if (known) return known.placeholder;
    const n = (this.counts.get(type) ?? 0) + 1;
    this.counts.set(type, n);
    const entry = { type, original, placeholder: `[${TAG[type]}_${n}]` };
    this.entries.set(key, entry);
    return entry.placeholder;
  }

  // Replaces the spans with placeholders.
  apply(text: string, spans: PhiSpan[]): string {
    let out = text;
    for (const span of [...spans].sort((a, b) => b.start - a.start)) {
      out = out.slice(0, span.start) + this.placeholderFor(span.type, span.text) + out.slice(span.end);
    }
    return out;
  }

  // Replaces what an earlier turn already found, wherever it shows up again: a surname alone, a
  // phone number written the same way. A name's parts count when they are four letters or more.
  hideKnown(text: string): string {
    const pieces: Array<{ value: string; entry: VaultEntry }> = [];
    for (const entry of this.entries.values()) {
      pieces.push({ value: entry.original, entry });
      if (entry.type === "name") {
        for (const part of entry.original.split(/\s+/)) if (part.replace(/[.,]/g, "").length >= 4 && nameLike(part)) pieces.push({ value: part, entry });
      }
    }
    let out = text;
    for (const { value, entry } of pieces.sort((a, b) => b.value.length - a.value.length)) {
      const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}\\[])${escaped}(?![\\p{L}\\p{N}\\]])`, "gu"), entry.placeholder);
    }
    return out;
  }

  // The reply the doctor reads: placeholders back to the words they came from.
  restore(text: string): string {
    const byPlaceholder = new Map([...this.entries.values()].map((entry) => [entry.placeholder, entry.original]));
    return text.replace(PLACEHOLDER, (placeholder) => byPlaceholder.get(placeholder) ?? placeholder);
  }

  restoreDeep<T>(value: T): T {
    if (typeof value === "string") return this.restore(value) as T;
    if (Array.isArray(value)) return value.map((item) => this.restoreDeep(item)) as T;
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.restoreDeep(item)])) as T;
    return value;
  }

  // Every original this vault holds. Tests and the measure use it to look for a leak.
  originals(): string[] {
    return [...this.entries.values()].map((entry) => entry.original);
  }

  get size(): number {
    return this.entries.size;
  }
}

// What a model-bound text looks like after the rules, then the model's extra spans.
export type SpanFinder = (scrubbed: string) => Promise<Array<{ text: string; type: PhiType }>>;

// found lists what was replaced in this call: the words and their type, as they were written.
export type Pseudonymised = { text: string; replaced: number; found: Array<{ type: PhiType; text: string }> };

// Rules first, then the model's words for what the rules missed. The model sees only the text the
// rules already scrubbed, and its words are accepted only when they are in that text.
export async function pseudonymise(text: string, vault: PhiVault, find?: SpanFinder): Promise<Pseudonymised> {
  const known = vault.hideKnown(text);
  const rules = findSpans(known);
  // A name's other mentions in the same message go too: "Papadakis Medical" after "Ms Eleni Papadakis".
  let out = vault.hideKnown(vault.apply(known, rules));
  const found = rules.map((span) => ({ type: span.type, text: span.text }));
  if (find && out.trim().length >= 20) {
    const more = findOnly(out, await find(out));
    out = vault.hideKnown(vault.apply(out, more));
    found.push(...more.map((span) => ({ type: span.type, text: span.text })));
  }
  return { text: out, replaced: found.length, found };
}

// The leak check. Every identifier the vault holds, found word for word in any of these texts
// (the text sent to the model, the trace payload, the checkpoint's bytes). Empty means no leak.
export function leakedFrom(vault: PhiVault, payloads: string[]): string[] {
  return vault.originals().filter((original) => original.length >= 3 && payloads.some((payload) => payload.includes(original)));
}

// --- The stateless scrub that older call sites use ------------------------------------------------
// The inbox, the events and the sweep scrub one text with no conversation to keep a map for. They
// get the same rules, with a label in place of a placeholder, and no model call.
const LABEL: Record<PhiType, string> = {
  name: "[name removed]",
  dob: "[date of birth removed]",
  address: "[address removed]",
  mrn: "[record number removed]",
  phone: "[phone number removed]",
  email: "[email removed]",
  national_id: "[ID number removed]"
};

export type Scrubbed = { text: string; removed: number };

export function scrubPhi(text: string): Scrubbed {
  const spans = findSpans(text);
  let out = text;
  for (const span of [...spans].reverse()) out = out.slice(0, span.start) + LABEL[span.type] + out.slice(span.end);
  return { text: out, removed: spans.length };
}

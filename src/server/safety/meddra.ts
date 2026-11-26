import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Coding an event term to MedDRA. The dictionary here is the teaching copy in
// data/hcp/safety/meddra-synthetic.json: its codes are made up and it is not MedDRA.
//
// The model proposes words. This file turns words into codes, and only the dictionary may supply
// a code: a term it does not hold gets no code, and a code it does not hold is refused.

const FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../data/hcp/safety/meddra-synthetic.json");

export type Soc = { code: string; name: string };
export type Pt = { code: string; name: string; soc: string };
export type Llt = { code: string; name: string; pt: string };
export type MeddraFile = { version: string; soc: Soc[]; pt: Pt[]; llt: Llt[] };

// What a coded event carries: the lowest level term, its preferred term, and that term's system organ class.
export type Coded = { llt: Llt; pt: Pt; soc: Soc };

const norm = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export class Dictionary {
  readonly version: string;
  private readonly socs = new Map<string, Soc>();
  private readonly pts = new Map<string, Pt>();
  private readonly llts = new Map<string, Llt>();
  private readonly lltByName = new Map<string, Llt>();

  constructor(file: MeddraFile) {
    this.version = file.version;
    for (const soc of file.soc) this.socs.set(soc.code, soc);
    for (const pt of file.pt) {
      if (!this.socs.has(pt.soc)) throw new Error(`PT ${pt.code} names a system organ class that is not in the dictionary.`);
      this.pts.set(pt.code, pt);
    }
    for (const llt of file.llt) {
      if (!this.pts.has(llt.pt)) throw new Error(`LLT ${llt.code} names a preferred term that is not in the dictionary.`);
      this.llts.set(llt.code, llt);
      // Two LLTs can share a name only when they share a PT, so the first one stands for both.
      if (!this.lltByName.has(norm(llt.name))) this.lltByName.set(norm(llt.name), llt);
    }
  }

  // A code the dictionary holds, or an error. Nothing else may reach a report.
  byLltCode(code: string): Coded {
    const llt = this.llts.get(code);
    if (!llt) throw new UnknownCode(code);
    return this.withLevels(llt);
  }

  byPtCode(code: string): Pt {
    const pt = this.pts.get(code);
    if (!pt) throw new UnknownCode(code);
    return pt;
  }

  // The words a model proposed, as a coded term: the lowest level term of that name (every
  // preferred term here has one of its own name). null when the dictionary has no such term.
  code(term: string): Coded | null {
    const llt = this.lltByName.get(norm(term));
    return llt ? this.withLevels(llt) : null;
  }

  // Every term the model may choose from, so a proposal is a pick, not an invention.
  termNames(): string[] {
    return [...new Set([...this.llts.values()].map((llt) => llt.name))];
  }

  private withLevels(llt: Llt): Coded {
    const pt = this.pts.get(llt.pt)!;
    return { llt, pt, soc: this.socs.get(pt.soc)! };
  }
}

export class UnknownCode extends Error {
  constructor(code: string) {
    super(`MedDRA code ${code} is not in the dictionary.`);
    this.name = "UnknownCode";
  }
}

let loaded: Dictionary | undefined;
export function dictionary(): Dictionary {
  loaded ??= new Dictionary(JSON.parse(readFileSync(FILE, "utf8")) as MeddraFile);
  return loaded;
}

import "../../src/server/load-env";
import { readFileSync, writeFileSync } from "node:fs";
import { env } from "../../src/server/env";
import { modelClient, useService } from "../../src/server/gateway";
import { scrubPhi } from "../../src/server/phi";
import { extractCase } from "../../src/server/safety/extract";
import { dictionary } from "../../src/server/safety/meddra";
useService("eval-runner");
const d = JSON.parse(readFileSync("data/hcp/safety/meddra-synthetic.json", "utf8"));
const ptName = new Map(d.pt.map((p: any) => [p.code, p.name]));
const lltName = new Map(d.llt.map((p: any) => [p.code, p.name]));
const rows = readFileSync("data/hcp/safety/ae-reports.jsonl", "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const out: any[] = [];
let next = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (next < rows.length) {
    const g = rows[next++];
    const text = scrubPhi(g.message).text;
    const c = await extractCase(modelClient(), env.openaiModel, text);
    const crit = Object.keys(g.criteria).filter((k) => g.criteria[k] !== (c.criteria as any)[k]).map((k) => `${k}: gold ${g.criteria[k]}`);
    const want = g.meddra.map((m: any) => `${lltName.get(m.llt)} -> ${ptName.get(m.pt)}`);
    const all = [...c.events, ...(c.situation ? [c.situation] : [])];
    const got = all.map((e) => `${e.reportedTerm} => ${e.coded ? e.coded.llt.name + " -> " + e.coded.pt.name : "none"}`);
    const ptOk = JSON.stringify([...new Set(g.meddra.map((m: any) => m.pt))].sort()) === JSON.stringify([...new Set(all.flatMap((e) => e.coded ? [e.coded.pt.code] : []))].sort());
    out.push({ id: g.id, route: g.expected_route, special: g.special_situation, msg: g.message, scrubbed: text, crit, ptOk, want, got, ex: c.extracted });
  }
}));
writeFileSync(process.argv[2]!, JSON.stringify(out, null, 1));

// Design's freight sample uses the world's names: seeded invoice ids, real tables and columns, reason codes,
// tools, people, and the contract's approvals. Each acceptance case in the sample runs against the reference
// employee and the rows it expects are the rows the ledger (or GET /approvals) holds.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Contract, contract } from "../checks/lib/contract";
import { type Running, startEmployee } from "../checks/lib/employee";
import { checkerWorld } from "../checks/lib/world";
import { costUsd, IDS, modelId, PRICES, provider, ROLES } from "../config/models";
import { REASON_CODES, SEED, TOOLS, type World } from "../worlds/freight-audit/world";

const ROOT = join(import.meta.dir, "..");
const DESIGN = join(ROOT, "parts", "01-design");
const read = (p: string) => readFileSync(join(DESIGN, p), "utf8");
const acceptance = Bun.YAML.parse(
  read("03-turn-the-hire-into-tests/solution/acceptance.yaml"),
) as any;
const tools = Bun.YAML.parse(read("04-list-tools-and-permissions/solution/tools.yaml")) as any;
const hire = (Bun.TOML.parse(read("02-write-the-hire-letter/solution/employee.toml")) as any).hire;
const SEEDED = new Set(readdirSync(join(SEED, "invoices")).map((f) => f.replace(/\.json$/, "")));
const PEOPLE = JSON.parse(readFileSync(join(SEED, "people.json"), "utf8")) as any[];
// The fields of one entry in the contract's GET /approvals (reference/CONTRACT.md).
const APPROVAL_FIELDS = [
  "approval_id",
  "job_id",
  "action",
  "amount",
  "summary",
  "approver_role",
  "status",
];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)],
  );
}

describe("Design names match the world", () => {
  let world: World;
  beforeAll(() => {
    world = checkerWorld();
  });
  afterAll(() => world.stop());
  const columns = (table: string) =>
    (world.db.query(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);

  test("every invoice id in the Design part is seeded", () => {
    const missing = walk(DESIGN)
      .filter((f) => /\.(md|ya?ml|toml)$/.test(f))
      .flatMap((f) =>
        (readFileSync(f, "utf8").match(/INV-\d{4}/g) ?? [])
          .filter((id) => !SEEDED.has(id))
          .map((id) => `${id} in ${f}`),
      );
    expect(missing).toEqual([]);
  });

  test("every expect row reads a real table and columns, or the contract's approvals", () => {
    for (const c of acceptance.cases)
      for (const r of c.expect) {
        const keys = [...Object.keys(r.where ?? {}), ...Object.keys(r.values ?? {})];
        if (r.route) for (const k of keys) expect(APPROVAL_FIELDS).toContain(k);
        else for (const k of keys) expect(columns(r.table)).toContain(k);
        if (r.values?.reason_code) expect(REASON_CODES).toContain(r.values.reason_code);
        if (r.values?.approver_role)
          expect(PEOPLE.map((p) => p.role)).toContain(r.values.approver_role);
      }
  });

  test("approvers are people in the world", () => {
    for (const c of acceptance.cases) {
      if (c.approver) expect(PEOPLE.map((p) => p.person_id)).toContain(c.approver);
      if (c.job.decide) expect(PEOPLE.map((p) => p.person_id)).toContain(c.job.decide.by);
    }
  });

  test("tools.yaml lists the world's tools with the world's risk", () => {
    const world = Object.fromEntries(TOOLS.map((t) => [t.name, t.kind]));
    expect(tools.tools.map((t: any) => t.name).sort()).toEqual(Object.keys(world).sort());
    for (const t of tools.tools) expect(t.risk).toBe(world[t.name]);
  });

  test("the hire letter's queries run on the ledger, and must_never.write is a world tool", () => {
    expect(() => world.db.query(hire.metric.query).all()).not.toThrow();
    expect(world.db.query(hire.must_never.check).all()).toEqual([]);
    expect(TOOLS.map((t) => t.name)).toContain(hire.must_never.write);
  });
});

describe("each acceptance case holds on the reference employee", () => {
  for (const c of acceptance.cases)
    test(c.name, async () => {
      const world = checkerWorld();
      let emp: Running | undefined;
      try {
        emp = await startEmployee(join(ROOT, "reference"), world.url);
        const api: Contract = contract(emp);
        const jobId = `acceptance-${c.name}`;
        await api.startJob({
          job_id: jobId,
          tenant: "kaas-freight",
          trigger: { kind: "person", by: "ravi" },
          input: { invoice_id: c.job.invoice_id },
        });
        let s = await api.waitJob(jobId);
        if (c.job.decide) {
          expect(s.status).toBe("waiting_for_human");
          const ap = ((await api.approvals("waiting")).body as any[]).find(
            (a) => a.job_id === jobId,
          );
          expect(
            (await api.decide(ap.approval_id, c.job.decide.decision, c.job.decide.by)).status,
          ).toBe(200);
          s = await api.waitJob(jobId, {
            until: (x) => !["working", "waiting_for_human"].includes(x.status),
          });
        }
        for (const r of c.expect) {
          let rows: any[];
          if (r.route) {
            const status =
              new URL(`http://x/${r.route.split(" ")[1]}`).searchParams.get("status") ?? "waiting";
            rows = ((await api.approvals(status)).body as any[]).filter((a) => a.job_id === jobId);
          } else {
            const where = Object.keys(r.where);
            rows = world.db
              .query(
                `SELECT * FROM ${r.table}${where.length ? " WHERE " + where.map((k) => `${k} = ?`).join(" AND ") : ""}`,
              )
              .all(...where.map((k) => r.where[k])) as any[];
          }
          const match = rows.filter((x) => Object.entries(r.where).every(([k, v]) => x[k] == v));
          expect(`${r.table ?? r.route} ${JSON.stringify(r.where)}: ${match.length} rows`).toBe(
            `${r.table ?? r.route} ${JSON.stringify(r.where)}: ${r.rows} rows`,
          );
          for (const [k, v] of Object.entries(r.values ?? {}))
            for (const x of match) expect(x[k]).toEqual(v);
        }
      } finally {
        await emp?.stop();
        world.stop();
      }
    }, 60_000);
});

describe("config/models.ts follows MODELS.md", () => {
  test("every provider maps every role, replay is the default and needs no key", () => {
    for (const p of Object.keys(IDS) as (keyof typeof IDS)[])
      for (const r of ROLES) expect(IDS[p][r].length).toBeGreaterThan(0);
    expect(provider({})).toBe("replay");
    expect(provider({ LLM_PROVIDER: "openai", MODEL_MODE: "replay" })).toBe("replay");
    expect(() => provider({ LLM_PROVIDER: "nope" })).toThrow();
    for (const r of ROLES) expect(PRICES[modelId(r, "replay")]).toBeDefined();
  });
  test("a model with no price costs unknown, never zero", () => {
    expect(costUsd("no-such-model", 1000, 1000)).toBeNull();
    for (const [id, p] of Object.entries(PRICES)) {
      expect(p.source).toMatch(/^https:\/\//);
      expect(costUsd(id, 1_000_000, 0)).toBeCloseTo(p.input);
    }
  });
});

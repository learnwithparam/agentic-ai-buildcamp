// Design's freight sample uses the world's names: seeded invoice ids, real tables and columns,
// reason codes, tools, people, and the contract's approvals. Each acceptance case in the sample
// runs against the reference employee and the rows it expects are the rows the ledger (or
// GET /approvals) holds.
import type { SQLQueryBindings } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type Contract, contract } from "../checks/lib/contract";
import { type Running, startEmployee } from "../checks/lib/employee";
import { checkerWorld } from "../checks/lib/world";
import { costUsd, IDS, modelId, PRICES, provider, ROLES } from "../config/models";
import { REASON_CODES, SEED, TOOLS, type World } from "../worlds/freight-audit/world";

// The shapes of the Design part's sample files, as far as these tests read them.
type ExpectedRows = {
  table?: string;
  route?: string;
  where: Record<string, unknown>;
  values?: Record<string, unknown>;
  rows: number;
};
type AcceptanceCase = {
  name: string;
  approver?: string;
  job: {
    invoice_id: string;
    decide?: { decision: "approve" | "decline"; by: string };
  };
  expect: ExpectedRows[];
};
type Acceptance = { cases: AcceptanceCase[] };
type ToolsYaml = { tools: { name: string; risk: string }[] };
type Hire = { metric: { query: string }; must_never: { check: string; write: string } };
type Person = { person_id: string; role: string };
type Row = Record<string, unknown>;

const ROOT = join(import.meta.dir, "..");
const DESIGN = join(ROOT, "parts", "01-design");
const read = (path: string) => readFileSync(join(DESIGN, path), "utf8");
const acceptance = Bun.YAML.parse(
  read("03-turn-the-hire-into-tests/solution/acceptance.yaml"),
) as Acceptance;
const tools = Bun.YAML.parse(
  read("04-list-tools-and-permissions/solution/tools.yaml"),
) as ToolsYaml;
const hireToml = Bun.TOML.parse(read("02-write-the-hire-letter/solution/employee.toml"));
const hire = (hireToml as { hire: Hire }).hire;
const seededFiles = readdirSync(join(SEED, "invoices"));
const SEEDED = new Set(seededFiles.map((file) => file.replace(/\.json$/, "")));
const PEOPLE = JSON.parse(readFileSync(join(SEED, "people.json"), "utf8")) as Person[];
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
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

function unseededIdsIn(file: string): string[] {
  const ids = readFileSync(file, "utf8").match(/INV-\d{4}/g) ?? [];
  const unseeded = ids.filter((id) => !SEEDED.has(id));
  return unseeded.map((id) => `${id} in ${file}`);
}

describe("Design names match the world", () => {
  let world: World;
  beforeAll(() => {
    world = checkerWorld();
  });
  afterAll(() => world.stop());
  const columns = (table: string) => {
    const info = world.db.query(`PRAGMA table_info(${table})`).all() as { name: string }[];
    return info.map((column) => column.name);
  };

  function expectRealNames(expected: ExpectedRows) {
    const keys = [...Object.keys(expected.where ?? {}), ...Object.keys(expected.values ?? {})];
    const allowed = expected.route ? APPROVAL_FIELDS : columns(String(expected.table));
    for (const key of keys) expect(allowed).toContain(key);
    const values = expected.values;
    if (values?.reason_code) expect(REASON_CODES).toContain(values.reason_code);
    if (values?.approver_role) {
      expect(PEOPLE.map((person) => person.role)).toContain(values.approver_role);
    }
  }

  test("every invoice id in the Design part is seeded", () => {
    const designFiles = walk(DESIGN).filter((file) => /\.(md|ya?ml|toml)$/.test(file));
    expect(designFiles.flatMap(unseededIdsIn)).toEqual([]);
  });

  test("every expect row reads a real table and columns, or the contract's approvals", () => {
    for (const acceptanceCase of acceptance.cases) {
      for (const expected of acceptanceCase.expect) expectRealNames(expected);
    }
  });

  test("approvers are people in the world", () => {
    const personIds = PEOPLE.map((person) => person.person_id);
    for (const acceptanceCase of acceptance.cases) {
      if (acceptanceCase.approver) expect(personIds).toContain(acceptanceCase.approver);
      const decide = acceptanceCase.job.decide;
      if (decide) expect(personIds).toContain(decide.by);
    }
  });

  test("tools.yaml lists the world's tools with the world's risk", () => {
    const worldRisk = Object.fromEntries(TOOLS.map((tool) => [tool.name, tool.kind]));
    const listedNames = tools.tools.map((tool) => tool.name);
    const worldNames = Object.keys(worldRisk);
    expect(listedNames.sort()).toEqual(worldNames.sort());
    for (const tool of tools.tools) expect(tool.risk).toBe(worldRisk[tool.name]);
  });

  test("the hire letter's queries run on the ledger, and must_never.write is a world tool", () => {
    expect(() => world.db.query(hire.metric.query).all()).not.toThrow();
    expect(world.db.query(hire.must_never.check).all()).toEqual([]);
    expect(TOOLS.map((tool) => tool.name)).toContain(hire.must_never.write);
  });
});

// The case's decision, made by the person it names, once the job waits for approval.
async function decideCase(api: Contract, jobId: string, acceptanceCase: AcceptanceCase) {
  const decide = acceptanceCase.job.decide;
  if (!decide) return;
  const approvals = (await api.approvals("waiting")).body as Row[];
  const approval = approvals.find((entry) => entry.job_id === jobId);
  expect(approval).toBeDefined();
  const answer = await api.decide(String(approval?.approval_id), decide.decision, decide.by);
  expect(answer.status).toBe(200);
  await api.waitJob(jobId, {
    until: (state) => !["working", "waiting_for_human"].includes(state.status),
  });
}

async function approvalRows(api: Contract, route: string, jobId: string): Promise<Row[]> {
  const routeUrl = new URL(`http://x/${route.split(" ")[1]}`);
  const status = routeUrl.searchParams.get("status") ?? "waiting";
  const approvals = (await api.approvals(status)).body as Row[];
  return approvals.filter((approval) => approval.job_id === jobId);
}

function ledgerRows(world: World, table: string, where: Record<string, unknown>): Row[] {
  const columns = Object.keys(where);
  const conditions = columns.map((column) => `${column} = ?`).join(" AND ");
  const whereClause = columns.length ? ` WHERE ${conditions}` : "";
  const bindings = columns.map((column) => where[column]) as SQLQueryBindings[];
  return world.db.query(`SELECT * FROM ${table}${whereClause}`).all(...bindings) as Row[];
}

function rowMatches(row: Row, where: Record<string, unknown>): boolean {
  // Loose equality on purpose: SQLite and YAML can spell the same value differently, as 1 and true.
  // biome-ignore lint/suspicious/noDoubleEquals: the loose match is the point here.
  return Object.entries(where).every(([column, wanted]) => row[column] == wanted);
}

type CaseRun = { api: Contract; world: World; jobId: string };

async function expectRows({ api, world, jobId }: CaseRun, expected: ExpectedRows) {
  const rows = expected.route
    ? await approvalRows(api, expected.route, jobId)
    : ledgerRows(world, String(expected.table), expected.where);
  const matching = rows.filter((row) => rowMatches(row, expected.where));
  const label = `${expected.table ?? expected.route} ${JSON.stringify(expected.where)}`;
  expect(`${label}: ${matching.length} rows`).toBe(`${label}: ${expected.rows} rows`);
  for (const [column, wanted] of Object.entries(expected.values ?? {})) {
    for (const row of matching) expect(row[column]).toEqual(wanted);
  }
}

async function runCase(employee: Running, world: World, acceptanceCase: AcceptanceCase) {
  const api: Contract = contract(employee);
  const jobId = `acceptance-${acceptanceCase.name}`;
  await api.startJob({
    job_id: jobId,
    tenant: "kaas-freight",
    trigger: { kind: "person", by: "ravi" },
    input: { invoice_id: acceptanceCase.job.invoice_id },
  });
  const state = await api.waitJob(jobId);
  if (acceptanceCase.job.decide) expect(state.status).toBe("waiting_for_human");
  await decideCase(api, jobId, acceptanceCase);
  for (const expected of acceptanceCase.expect) await expectRows({ api, world, jobId }, expected);
}

describe("each acceptance case holds on the reference employee", () => {
  for (const acceptanceCase of acceptance.cases) {
    test(acceptanceCase.name, async () => {
      const world = checkerWorld();
      let employee: Running | undefined;
      try {
        employee = await startEmployee(join(ROOT, "reference"), world.url);
        await runCase(employee, world, acceptanceCase);
      } finally {
        await employee?.stop();
        world.stop();
      }
    }, 60_000);
  }
});

describe("config/models.ts follows MODELS.md", () => {
  test("every provider maps every role, replay is the default and needs no key", () => {
    for (const providerName of Object.keys(IDS) as (keyof typeof IDS)[]) {
      for (const role of ROLES) expect(IDS[providerName][role].length).toBeGreaterThan(0);
    }
    expect(provider({})).toBe("replay");
    // Environment variable names are upper case, so these maps are built from pairs.
    const openAiInReplay = Object.fromEntries([
      ["LLM_PROVIDER", "openai"],
      ["MODEL_MODE", "replay"],
    ]);
    const unknownProvider = Object.fromEntries([["LLM_PROVIDER", "nope"]]);
    expect(provider(openAiInReplay)).toBe("replay");
    expect(() => provider(unknownProvider)).toThrow();
    for (const role of ROLES) expect(PRICES[modelId(role, "replay")]).toBeDefined();
  });
  test("a model with no price costs unknown, never zero", () => {
    expect(costUsd("no-such-model", 1000, 1000)).toBeNull();
    for (const [id, price] of Object.entries(PRICES)) {
      expect(price.source).toMatch(/^https:\/\//);
      expect(costUsd(id, 1_000_000, 0)).toBeCloseTo(price.input);
    }
  });
});

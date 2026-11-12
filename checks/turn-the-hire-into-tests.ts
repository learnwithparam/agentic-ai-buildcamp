import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { hasFile, hireFor, readYaml, schemaIn, validate } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "03-turn-the-hire-into-tests");

type ExpectedRow = { table?: unknown; route?: unknown; rows?: unknown };
type AcceptanceCase = {
  kind?: unknown;
  forbids?: unknown;
  approver?: unknown;
  expect?: ExpectedRow[];
};
type AcceptanceFile = { cases?: AcceptanceCase[] } | undefined;

const acceptanceFile = (folder: string) => readYaml<AcceptanceFile>(folder, "acceptance.yaml");

function cases(folder: string): AcceptanceCase[] {
  const listed = acceptanceFile(folder)?.cases;
  return Array.isArray(listed) ? listed : [];
}

const mustNeverCases = (folder: string) =>
  cases(folder).filter((acceptanceCase) => acceptanceCase.kind === "must-never");

const REPLY_KEY = /^(reply|replies|says|message|answer|response|text)$/i;

// A case that checks what the employee said, anywhere inside it, checks the wrong thing.
function mentionsReply(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(mentionsReply);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, inner]) => REPLY_KEY.test(key) || mentionsReply(inner));
}

// Each expected row names a table or an HTTP route, never both and never neither.
const namesTableOrRoute = (row: ExpectedRow | undefined) => !!row?.table !== !!row?.route;

function expectsRowsOnly(acceptanceCase: AcceptanceCase): boolean {
  const expected = acceptanceCase.expect;
  return Array.isArray(expected) && !mentionsReply(expected) && expected.every(namesTableOrRoute);
}

function isApprovalWithApprover(acceptanceCase: AcceptanceCase): boolean {
  const { approver } = acceptanceCase;
  return (
    acceptanceCase.kind === "approval" && typeof approver === "string" && approver.trim().length > 0
  );
}

export default [
  {
    says: "acceptance.yaml exists and is valid YAML",
    test: (folder) =>
      hasFile(folder, "acceptance.yaml") && typeof acceptanceFile(folder) === "object",
    tryNext: "create acceptance.yaml in this folder and check the indents line up",
  },
  {
    says: "every case states rows in the system of record, never the reply",
    test: (folder) => cases(folder).length > 0 && cases(folder).every(expectsRowsOnly),
    tryNext:
      "give every expect row a table (or route: GET /approvals for a job waiting on a person), " +
      "a where and the row count you expect",
  },
  {
    says: "acceptance.yaml matches acceptance.schema.json",
    test: (folder) => {
      const schema = schemaIn(STEP, "acceptance.schema.json");
      return validate(schema, acceptanceFile(folder)).length === 0;
    },
    tryNext: "compare your file with the shape in the README, one key at a time",
  },
  {
    says: "there are at least 5 cases",
    test: (folder) => cases(folder).length >= 5,
    tryNext:
      "add cases until you have five: the happy path, a must-never trap, an approval and two edges",
  },
  {
    says: "a must-never case forbids the write named in your hire letter",
    test: (folder) => {
      const forbiddenWrite = hireFor(folder)?.must_never?.write;
      return (
        !!forbiddenWrite && mustNeverCases(folder).some((trap) => trap.forbids === forbiddenWrite)
      );
    },
    tryNext:
      "add a case with kind: must-never and set forbids: " +
      "to the write in your hire letter's must_never",
  },
  {
    says: "every must-never case expects zero forbidden rows",
    test: (folder) => {
      const traps = mustNeverCases(folder);
      const expectsNoRows = (trap: AcceptanceCase) =>
        (trap.expect ?? []).some((row) => row.rows === 0);
      return traps.length > 0 && traps.every(expectsNoRows);
    },
    tryNext: "under each must-never case, expect the forbidden table with rows: 0",
  },
  {
    says: "an approval case names who approves",
    test: (folder) => cases(folder).some(isApprovalWithApprover),
    tryNext: "add a case with kind: approval and set approver: to the person who must say yes",
  },
] satisfies Rule[];

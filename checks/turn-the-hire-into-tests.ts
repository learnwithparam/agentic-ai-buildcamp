import { join } from "node:path";
import type { Rule } from "../scripts/verify";
import { has, hireFor, schemaIn, validate, yaml } from "./design-lib";

const STEP = join(import.meta.dir, "..", "parts", "01-design", "03-turn-the-hire-into-tests");
const file = (d: string) => yaml(d, "acceptance.yaml");
const cases = (d: string): any[] => (Array.isArray(file(d)?.cases) ? file(d).cases : []);
const traps = (d: string) => cases(d).filter((c) => c.kind === "must-never");
const REPLY = /^(reply|replies|says|message|answer|response|text)$/i;
const mentionsReply = (v: unknown): boolean =>
  Array.isArray(v)
    ? v.some(mentionsReply)
    : v && typeof v === "object"
      ? Object.entries(v).some(([k, x]) => REPLY.test(k) || mentionsReply(x))
      : false;

export default [
  {
    says: "acceptance.yaml exists and is valid YAML",
    test: (d) => has(d, "acceptance.yaml") && typeof file(d) === "object",
    tryNext: "create acceptance.yaml in this folder and check the indents line up",
  },
  {
    says: "every case states rows in the system of record, never the reply",
    test: (d) =>
      cases(d).length > 0 &&
      cases(d).every(
        (c) =>
          Array.isArray(c.expect) &&
          !mentionsReply(c.expect) &&
          c.expect.every((r: any) => !!r?.table !== !!r?.route),
      ),
    tryNext:
      "give every expect row a table (or route: GET /approvals for a job waiting on a person), a where and the row count you expect",
  },
  {
    says: "acceptance.yaml matches acceptance.schema.json",
    test: (d) => validate(schemaIn(STEP, "acceptance.schema.json"), file(d)).length === 0,
    tryNext: "compare your file with the shape in the README, one key at a time",
  },
  {
    says: "there are at least 5 cases",
    test: (d) => cases(d).length >= 5,
    tryNext:
      "add cases until you have five: the happy path, a must-never trap, an approval and two edges",
  },
  {
    says: "a must-never case forbids the write named in your hire letter",
    test: (d) => {
      const w = hireFor(d)?.must_never?.write;
      return !!w && traps(d).some((c) => c.forbids === w);
    },
    tryNext:
      "add a case with kind: must-never and set forbids: to the write in your hire letter's must_never",
  },
  {
    says: "every must-never case expects zero forbidden rows",
    test: (d) =>
      traps(d).length > 0 && traps(d).every((c) => (c.expect ?? []).some((r: any) => r.rows === 0)),
    tryNext: "under each must-never case, expect the forbidden table with rows: 0",
  },
  {
    says: "an approval case names who approves",
    test: (d) =>
      cases(d).some(
        (c) =>
          c.kind === "approval" && typeof c.approver === "string" && c.approver.trim().length > 0,
      ),
    tryNext: "add a case with kind: approval and set approver: to the person who must say yes",
  },
] satisfies Rule[];

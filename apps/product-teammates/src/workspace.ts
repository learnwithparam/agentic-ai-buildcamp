// Workspaces keep teams apart. A person reads a workspace only when a member grant says so.
// Tone notes stay inside one workspace. A briefing waits as a row until an approver decides.
import { join } from "node:path";
import { inTransaction, rows } from "../../../packages/core/src/db";
import { ROOT } from "../../../scripts/root";
import type { AgentResult } from "../../../src/grade";

const TABLES = `
  CREATE TABLE IF NOT EXISTS tone_notes (id serial PRIMARY KEY, workspace text, person text,
    note text);
  CREATE TABLE IF NOT EXISTS briefings (id serial PRIMARY KEY, writer text, workspace text,
    body text, status text DEFAULT 'pending', approved_by text)`;

export async function setupWorkspace(): Promise<void> {
  await rows(TABLES);
}

export async function resetWorkspace(): Promise<void> {
  await rows("DROP TABLE IF EXISTS tone_notes, briefings");
  await setupWorkspace();
}

function refuse(text: string): AgentResult {
  return { route: "refuse", text, citations: [] };
}

// #region lab:tenancy-and-memory
export async function isMember(person: string, workspace: string): Promise<boolean> {
  const found = await rows(
    "SELECT 1 FROM grants WHERE person = $1 AND relation = 'member' AND object = $2",
    [person, workspace],
  );
  return found.length > 0;
}

export async function homeWorkspace(person: string): Promise<string> {
  const found = await rows<{ object: string }>(
    "SELECT object FROM grants WHERE person = $1 AND relation = 'member' ORDER BY object LIMIT 1",
    [person],
  );
  if (found.length === 0) throw new Error(`${person} belongs to no workspace.`);
  return found[0].object;
}

// The wall comes first. A person outside the workspace never reaches the file.
export async function readMemo(person: string, workspace: string): Promise<string | undefined> {
  if (!(await isMember(person, workspace))) return undefined;
  const file = Bun.file(join(ROOT, ".data", "workspaces", `${workspace}-memo.txt`));
  if (!(await file.exists())) return undefined;
  return (await file.text()).trim();
}

export async function rememberTone(person: string, workspace: string, note: string): Promise<void> {
  await setupWorkspace();
  await rows("INSERT INTO tone_notes (workspace, person, note) VALUES ($1, $2, $3)", [
    workspace,
    person,
    note,
  ]);
}

export async function recallTone(person: string, workspace: string): Promise<string | undefined> {
  await setupWorkspace();
  const found = await rows<{ note: string }>(
    `SELECT note FROM tone_notes WHERE person = $1 AND workspace = $2
     ORDER BY id DESC LIMIT 1`,
    [person, workspace],
  );
  if (found.length === 0) return undefined;
  return found[0].note;
}

export async function submitBriefing(writer: string, workspace: string, body: string) {
  await setupWorkspace();
  const [row] = await rows<{ id: number }>(
    "INSERT INTO briefings (writer, workspace, body) VALUES ($1, $2, $3) RETURNING id",
    [writer, workspace, body],
  );
  return row.id;
}

// One decision, once. The writer can never be the approver.
export async function approveBriefing(id: number, approver: string): Promise<void> {
  await inTransaction(async (run) => {
    const found = await run("SELECT * FROM briefings WHERE id = $1 AND status = 'pending'", [id]);
    if (found.rows.length === 0) throw new Error(`Briefing ${id} is not waiting.`);
    const briefing = found.rows[0] as { writer: string; workspace: string };
    if (briefing.writer === approver)
      throw new Error("A writer cannot approve their own briefing.");
    const grant =
      "SELECT 1 FROM grants WHERE person = $1 AND relation = 'approves' AND object = $2";
    const allowed = await run(grant, [approver, "briefings"]);
    if (allowed.rows.length === 0) throw new Error(`${approver} may not approve briefings.`);
    const update = "UPDATE briefings SET status = 'published', approved_by = $2 WHERE id = $1";
    await run(update, [id, approver]);
  });
}

export async function publishedIn(workspace: string): Promise<string[]> {
  await setupWorkspace();
  const found = await rows<{ body: string }>(
    "SELECT body FROM briefings WHERE workspace = $1 AND status = 'published' ORDER BY id",
    [workspace],
  );
  return found.map((item) => item.body);
}

async function memoAnswer(person: string): Promise<AgentResult> {
  const workspace = "enterprise-stealth";
  const memo = await readMemo(person, workspace);
  if (memo === undefined) return refuse("You do not have access to that workspace.");
  return { route: "answer", text: memo, citations: [workspace] };
}

async function toneAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  const note = await recallTone(person, workspace);
  const text = `I have no tone saved for you in ${workspace}.`;
  if (note === undefined) return { route: "answer", text, citations: [workspace] };
  const said = `Using your tone in ${workspace}: ${note}`;
  return { route: "answer", text: said, citations: [workspace] };
}

async function publishAnswer(person: string): Promise<AgentResult> {
  const workspace = await homeWorkspace(person);
  const id = await submitBriefing(person, workspace, "The Monday briefing");
  const text = `The briefing waits for an approver. Approval ${id} is waiting.`;
  return { route: "approve", text, citations: [workspace] };
}

async function ownApprovalAnswer(person: string): Promise<AgentResult> {
  await setupWorkspace();
  const waiting = await rows<{ id: number }>(
    "SELECT id FROM briefings WHERE writer = $1 AND status = 'pending' ORDER BY id DESC LIMIT 1",
    [person],
  );
  if (waiting.length === 0) return refuse("You have no briefing waiting.");
  try {
    await approveBriefing(waiting[0].id, person);
  } catch (problem) {
    return refuse((problem as Error).message);
  }
  return { route: "answer", text: "The briefing is published.", citations: [] };
}

export async function answerWorkspace(
  question: string,
  person: string,
): Promise<AgentResult | undefined> {
  const text = question.toLowerCase();
  if (text.includes("memo")) return memoAnswer(person);
  if (text.includes("tone")) return toneAnswer(person);
  if (text.includes("approve my own")) return ownApprovalAnswer(person);
  if (text.includes("publish")) return publishAnswer(person);
  return undefined;
}
// #stub
//~ // TODO(tenancy-and-memory): wall the memo, scope the tone notes, let only an approver publish
//~ export async function isMember(_person: string, _workspace: string): Promise<boolean> {
//~   return true;
//~ }
//~
//~ export async function homeWorkspace(_person: string): Promise<string> {
//~   return "core-growth";
//~ }
//~
//~ export async function readMemo(_who: string, _space: string): Promise<string | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function rememberTone(
//~   _who: string,
//~   _space: string,
//~   _note: string,
//~ ): Promise<void> {}
//~
//~ export async function recallTone(_person: string, _space: string): Promise<string | undefined> {
//~   return undefined;
//~ }
//~
//~ export async function submitBriefing(_writer: string, _space: string, _body: string) {
//~   return 0;
//~ }
//~
//~ export async function approveBriefing(_id: number, _approver: string): Promise<void> {}
//~
//~ export async function publishedIn(_workspace: string): Promise<string[]> {
//~   return [];
//~ }
//~
//~ export async function answerWorkspace(
//~   _question: string,
//~   _person: string,
//~ ): Promise<AgentResult | undefined> {
//~   return undefined;
//~ }
// #endregion

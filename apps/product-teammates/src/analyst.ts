// The product analyst teammate. A skill is a small file with the words that wake it
// and one select query. The analyst picks a skill, checks its query, and reports the numbers.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { guardQuery } from "../../../packages/core/src/bi";
import { rows } from "../../../packages/core/src/db";
import { type Tags, traced } from "../../../packages/core/src/telemetry";
import type { AgentResult } from "../../../src/grade";

export type Skill = { name: string; when: string[]; sql: string; chart?: boolean };
export type Row = Record<string, unknown>;

const SKILL_FOLDER = join(import.meta.dir, "..", "skills");
const OWNER = "analytics";

export async function loadSkills(): Promise<Skill[]> {
  const skills: Skill[] = [];
  for (const file of readdirSync(SKILL_FOLDER).sort()) {
    const loaded = await import(join(SKILL_FOLDER, file));
    skills.push(loaded.skill as Skill);
  }
  return skills;
}

// #region lab:product-intelligence-bi
const PERSONAL = ["email", "phone", "address"];

export function asksForPersonalData(question: string): boolean {
  const text = question.toLowerCase();
  return PERSONAL.some((word) => text.includes(word));
}

export function pickSkill(question: string, skills: Skill[]): Skill | undefined {
  const text = question.toLowerCase();
  return skills.find((skill) => skill.when.some((word) => text.includes(word)));
}

// The query is checked by code before it runs. A bad query never reaches the database.
export async function runSkill(skill: Skill, tags: Tags): Promise<Row[]> {
  const problem = guardQuery(skill.sql, OWNER);
  if (problem !== undefined) throw new Error(`Skill ${skill.name} cannot run: ${problem}.`);
  return traced("analyst.skill", tags, async (setAttributes) => {
    const found = await rows<Row>(skill.sql);
    setAttributes({ skill: skill.name, sql: skill.sql, row_count: found.length });
    return found;
  });
}

function describe(found: Row[]): string {
  const lines = found.map((row) => {
    const pairs = Object.entries(row).map(([name, value]) => `${name}: ${value}`);
    return pairs.join(", ");
  });
  return lines.join("\n");
}

// A chart is a plain line spec. The first column is the x axis and the second is the y axis.
function lineSpec(skill: Skill, found: Row[]): string {
  const [xName, yName] = Object.keys(found[0]);
  const points = found.map((row) => [row[xName], row[yName]]);
  return JSON.stringify({ type: "line", title: skill.name, x: xName, y: yName, points });
}

export async function answerAnalysis(
  question: string,
  tags: Tags,
  skills: Skill[],
): Promise<AgentResult | undefined> {
  if (asksForPersonalData(question)) {
    const text = "I only report totals. I never list people or their contact details.";
    return { route: "refuse", text, citations: [] };
  }
  const skill = pickSkill(question, skills);
  if (skill === undefined) return undefined;
  const found = await runSkill(skill, tags);
  let text = describe(found);
  if (skill.chart === true && found.length > 0) text = `chart: ${lineSpec(skill, found)}`;
  return { route: "answer", text, citations: [skill.name] };
}
// #stub
//~ // TODO(product-intelligence-bi): pick a skill, check its query, run it, report the numbers
//~ export function asksForPersonalData(_question: string): boolean {
//~   return false;
//~ }
//~
//~ export function pickSkill(_question: string, _skills: Skill[]): Skill | undefined {
//~   return undefined;
//~ }
//~
//~ export async function runSkill(_skill: Skill, _tags: Tags): Promise<Row[]> {
//~   return [];
//~ }
//~
//~ export async function answerAnalysis(
//~   _question: string,
//~   _tags: Tags,
//~   _skills: Skill[],
//~ ): Promise<AgentResult | undefined> {
//~   return undefined;
//~ }
// #endregion

// Writes syllabus.json, the 6-week course outline the course platform imports.
// `tsx scripts/syllabus.ts` writes it. `tsx scripts/syllabus.ts --check` (part of `npm run check`) fails
// when the file is stale or invalid. Staleness ignores source.sha, which is the commit it was made on.
// Every numbered lesson in docs/learner lands in exactly one week, and the build fails on one that is not mapped.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";

const REPO = "learnwithparam/agentic-ai-buildcamp";
const FILE = "syllabus.json";
const LESSONS = "docs/learner";
const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const MAX_BYTES = 256 * 1024;
// Lessons with no checkpoint tag are linked by their page instead.
const NO_TAG = new Set(["23"]);

const WEEKS = [
  { key: "w1", title: "Agentic system design", lessons: ["00", "01", "13", "14", "15", "16"], reading: "Read the lesson map in the README and the whole-system diagrams and concepts in docs/walkthrough.md.", live: ["Live session 1: designing an agent system", "Live session 2: review of this week's builds"] },
  { key: "w2", title: "Search and retrieval patterns", lessons: ["20", "21", "22"], reading: "Read docs/measures.md for how search is scored, and docs/learner/data.md for what the agents read.", live: ["Live session 1: retrieval patterns", "Live session 2: review of this week's builds"] },
  { key: "w3", title: "Evals and agentic AI security", lessons: ["05", "06", "07", "08", "09", "11", "12"], reading: "Read docs/learner/evals.md for how eval cases work, and docs/scoreboard.md for the reference rows.", live: ["Live session 1: evals and security", "Live session 2: review of this week's builds"] },
  { key: "w4", title: "Agent deployment and CI/CD", lessons: ["10", "17", "18", "19"], reading: "Read docs/learner/troubleshooting.md and the CI workflow in .github/workflows/check.yml.", live: ["Live session 1: shipping an agent", "Live session 2: review of this week's builds"] },
  { key: "w5", title: "Observability, scaling and optimization", lessons: ["02", "03", "04"], reading: "Read docs/one-question.md to follow one question through the system.", live: ["Live session 1: observability and optimization", "Live session 2: review of this week's builds"] },
  { key: "w6", title: "Production capstone", lessons: ["23"], reading: "Reread docs/walkthrough.md and your my-scoreboard.md before you start the capstone.", live: ["Live session 1: capstone kickoff", "Live session 2: capstone demos"] },
];

type Item = Record<string, unknown>;
type Tree = { modules: Array<{ key: string; title: string; units: Array<{ key: string; title: string; items: Item[] }> }> };
type Syllabus = { source: { repo: string; ref: string; sha: string }; tree: Tree };

const lessonFiles = () => readdirSync(LESSONS).filter((name) => /^\d\d-.+\.md$/.test(name)).sort();
const title = (file: string) => /^# (.+)$/m.exec(readFileSync(`${LESSONS}/${file}`, "utf8"))?.[1].trim() ?? fail(`${file}: no # title`);
function fail(message: string): never {
  throw new Error(message);
}

export function buildTree(): Tree {
  const files = lessonFiles();
  const mapped = WEEKS.flatMap((week) => week.lessons);
  for (const file of files) {
    const count = mapped.filter((number) => file.startsWith(`${number}-`)).length;
    if (count !== 1) fail(`${LESSONS}/${file}: in ${count} weeks, want exactly 1. Map it in WEEKS in scripts/syllabus.ts.`);
  }
  for (const number of mapped) if (!files.some((file) => file.startsWith(`${number}-`))) fail(`WEEKS maps lesson ${number}, which has no page.`);
  const modules = WEEKS.map((week) => {
    const labs: Item[] = week.lessons.map((number) => {
      const file = files.find((name) => name.startsWith(`${number}-`))!;
      const slug = file.replace(/\.md$/, "");
      const repoPath = NO_TAG.has(number) ? `${LESSONS}/${file}` : `checkpoint/${number}-${TAG_NAMES[number]}`;
      return {
        key: `lab-${slug}`.slice(0, 64),
        kind: "lab",
        title: title(file),
        minutes: 60,
        body_md: `Read [the lesson](${LESSONS}/${file}), then build it. ${NO_TAG.has(number) ? "This lesson has no checkpoint tag; it runs on main." : `Jump to the finished state with \`git checkout ${repoPath}\`.`}`,
        lab: { slug, repo_path: repoPath },
        proof: { kind: "none" },
        rubric_key: "cohort",
      };
    });
    const units: Tree["modules"][number]["units"] = [
      { key: `${week.key}-read`, title: "Read", items: [{ key: `${week.key}-reading`, kind: "reading", title: `${week.title}: reading`, minutes: 30, body_md: week.reading }] },
      { key: `${week.key}-build`, title: "Build", items: labs },
      { key: `${week.key}-live`, title: "Live sessions", items: week.live.map((liveTitle, index) => ({ key: `${week.key}-live-${index + 1}`, kind: "live", title: liveTitle, minutes: 90 })) },
    ];
    if (week.key === "w6") {
      units.push({
        key: "w6-capstone",
        title: "Capstone",
        items: [{ key: "w6-capstone-task", kind: "task", title: "Production capstone", minutes: 180, body_md: "Ship your agent end to end: run the full course on your laptop, pass the release gate, and submit a screenshot of your passing run and scoreboard.", proof: { kind: "screenshot" }, rubric_key: "cohort" }],
      });
    }
    return { key: week.key, title: week.title, units };
  });
  return { modules };
}

// Checkpoint tag suffixes, as named in AGENTS.md.
const TAG_NAMES: Record<string, string> = {
  "00": "setup", "01": "base-app", "02": "tracing", "03": "prompt-management", "04": "monitoring", "05": "dataset", "06": "experiments", "07": "evaluation", "08": "midpoint", "09": "advanced-evals", "10": "ai-gateway", "11": "sign-in", "12": "mcp-sandbox", "13": "durable-review", "14": "content-agents", "15": "a2a", "16": "events", "17": "autonomy", "18": "release-gate", "19": "cli", "20": "rag", "21": "citations", "22": "insights",
};

const ITEM_FIELDS = new Set(["key", "kind", "title", "minutes", "body_md", "lab", "proof", "rubric_key"]);
export function problems(doc: Syllabus): string[] {
  const out: string[] = [];
  const keys = new Set<string>();
  const seen = (key: unknown, where: string) => {
    if (typeof key !== "string" || !KEY.test(key)) out.push(`${where}: bad key ${JSON.stringify(key)}`);
    else if (keys.has(key)) out.push(`${where}: duplicate key ${key}`);
    else keys.add(key);
  };
  if (doc.source?.repo !== REPO || doc.source.ref !== "main" || !/^[0-9a-f]{40}$/.test(doc.source.sha)) out.push("source: want repo, ref main and a 40 character sha");
  if (doc.tree.modules.length !== 6) out.push("want 6 modules");
  for (const module of doc.tree.modules) {
    seen(module.key, `module ${module.key}`);
    for (const unit of module.units) {
      seen(unit.key, `unit ${unit.key}`);
      for (const item of unit.items) {
        seen(item.key, `item ${item.key}`);
        for (const field of Object.keys(item)) if (!ITEM_FIELDS.has(field)) out.push(`item ${item.key}: field ${field} not allowed`);
        if (!["video", "reading", "lab", "task", "live"].includes(item.kind as string)) out.push(`item ${item.key}: bad kind`);
        if (item.kind === "lab" && (!item.lab || item.rubric_key !== "cohort" || !item.proof)) out.push(`item ${item.key}: a lab needs lab, proof and rubric_key cohort`);
        if (item.kind === "task" && (item.rubric_key !== "cohort" || (item.proof as { kind?: string } | undefined)?.kind !== "screenshot")) out.push(`item ${item.key}: the capstone needs proof screenshot and rubric_key cohort`);
      }
    }
  }
  if (JSON.stringify(doc).includes(String.fromCharCode(8212))) out.push("no em dashes");
  if (Buffer.byteLength(JSON.stringify(doc)) > MAX_BYTES) out.push("over 256 KB");
  return out;
}

if (process.argv[1]?.endsWith("syllabus.ts")) {
  const tree = buildTree();
  if (process.argv.includes("--check")) {
    let current: Syllabus;
    try {
      current = JSON.parse(readFileSync(FILE, "utf8"));
    } catch {
      fail(`${FILE}: missing or not JSON. Run: npx tsx scripts/syllabus.ts`);
    }
    const found = problems(current);
    if (!isDeepStrictEqual(current.tree, tree)) found.push(`${FILE} is stale. Run: npx tsx scripts/syllabus.ts`);
    if (found.length) {
      console.error(found.join("\n"));
      process.exit(1);
    }
    console.log("syllabus.json is current");
  } else {
    const sha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    const doc: Syllabus = { source: { repo: REPO, ref: "main", sha }, tree };
    const found = problems(doc);
    if (found.length) fail(found.join("\n"));
    writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
    console.log(`wrote ${FILE}`);
  }
}

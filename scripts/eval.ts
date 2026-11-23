// bun run eval hcp runs the whole golden set and exits with 1 when the gate is closed.
// The gate opens only at 24 of 24. Each run is also recorded in Phoenix as an experiment.
// Without --live, the agent uses the recorded replies. With --live, it calls the gateway,
// and the score and the cost go to .state/release-notes.md.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { provider } from "../config/models";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { personNamed } from "../data/catalog/people";
import { recall } from "../packages/core/src/approvals";
import { ask } from "../packages/core/src/ask";
import { closeDatabase } from "../packages/core/src/db";
import {
  experimentPayload,
  gate,
  gateText,
  type RunNote,
  recordExperiment,
  releaseNotes,
} from "../packages/core/src/gate";
import { NoRecording } from "../packages/core/src/replay";
import { askTeam, type Models } from "../packages/core/src/team";
import { grade } from "../src/grade";
import { quotingModels } from "../src/offline";
import { ROOT } from "./root";

const live = process.argv.includes("--live");
if (live && provider() === "replay") {
  console.error("Add a model key and set LLM_PROVIDER first, or run without --live.");
  process.exit(2);
}

let costUsd = 0;

// Each model call goes through the one door. In replay, a prompt with no recording falls back
// to the stand-in model for documents. A numbers question has no stand-in and fails the case.
function modelsFor(memory: string, tenantId: string): Models {
  const tags = { tenantId, agentName: "team" };
  const call = async (prompt: string) => {
    const reply = await ask("smart", memory + prompt, tags);
    if (reply.costUsd > 0) costUsd += reply.costUsd;
    return reply.text;
  };
  return {
    generate: async (prompt) => {
      try {
        return await call(prompt);
      } catch (error) {
        if (live || !(error instanceof NoRecording)) throw error;
        return quotingModels().generate(prompt);
      }
    },
    writeQuery: call,
  };
}

async function runCase(golden: (typeof HCP_GOLDEN.cases)[number]) {
  try {
    const person = personNamed(golden.persona);
    const notes = await recall(person.name);
    const memory = notes.length === 0 ? "" : `Notes about this person: ${notes.join(" ")}\n`;
    const result = await askTeam(golden.question, person.name, modelsFor(memory, person.tenant));
    return grade(golden, result);
  } catch (error) {
    return { ok: false, reasons: [`the case stopped: ${(error as Error).message}`] };
  }
}

const grades = [];
for (const golden of HCP_GOLDEN.cases) grades.push(await runCase(golden));
const result = gate(HCP_GOLDEN, grades);
console.log(gateText(result));

const note: RunNote = {
  mode: live ? "live" : "replay",
  costUsd,
  label: new Date().toISOString().slice(0, 19).replaceAll(":", "-"),
};
try {
  const id = await recordExperiment(experimentPayload(HCP_GOLDEN, grades, note));
  console.log(`Experiment ${id} recorded in Phoenix.`);
} catch (error) {
  console.error(`Phoenix did not record the experiment: ${(error as Error).message}`);
}
if (live) {
  const file = join(ROOT, ".state", "release-notes.md");
  mkdirSync(join(ROOT, ".state"), { recursive: true });
  writeFileSync(file, releaseNotes(result, note));
  console.log(`Score and cost written to ${file}.`);
}
await closeDatabase();
process.exit(result.open ? 0 : 1);

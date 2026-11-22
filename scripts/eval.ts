// bun run eval hcp runs the whole golden set and exits with 1 when the gate is closed.
// Add --live to use real models. Without it, the agent uses the recorded replies.
import { runGolden } from "../apps/hcp-showcase/src/scoreboard";
import { provider } from "../config/models";
import { HCP_GOLDEN } from "../data/catalog/golden-hcp";
import { closeDatabase } from "../packages/core/src/db";
import { gate, gateText } from "../packages/core/src/gate";
import { liveAgent } from "../packages/core/src/team";

const live = process.argv.includes("--live");
if (live && provider() === "replay") {
  console.error("Add a model key and set LLM_PROVIDER first, or run without --live.");
  process.exit(2);
}

const grades = await runGolden(liveAgent(), HCP_GOLDEN);
const result = gate(HCP_GOLDEN, grades);
console.log(gateText(result));
await closeDatabase();
process.exit(result.open ? 0 : 1);

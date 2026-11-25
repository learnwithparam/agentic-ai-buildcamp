import { generations, resetSpans, stopTracing } from "../../../scripts/live-spans";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { FixedControls } from "./limits";
import { countingDesk, fgaOfPharmaA } from "./counting-desk";
import { createSweep } from "./sweep";

// Lesson 17, on the real model through the gateway (npm run check:live). The one model call the
// sweep makes itself is the picker: which of the company's doctors an instruction is about. These
// tests run it for real and check what the code does with its answer, never its wording.

const LIMITS = { paused: false, budgetUsd: 0.5, changedBy: null, changedAt: null };
after(() => stopTracing());
beforeEach(() => resetSpans());

const sweepOf = (desk: Parameters<typeof createSweep>[0]["desk"], spend: () => Promise<number> = async () => 0) =>
  createSweep({ desk, controls: new FixedControls(LIMITS), spend, client: fgaOfPharmaA });

test("an instruction is planned per doctor OpenFGA shows the sweep, and another company's doctor is never planned", async () => {
  const { desk, planned } = countingDesk();
  // HCP-1004 is Pharma B's doctor, so the sweep of Pharma A cannot pick it.
  const result = await sweepOf(desk)({ tenantId: "pharma_a", today: "2026-11-23", runId: "live", instruction: "Clear the pending sample requests for HCP-1001 and HCP-1004." });
  assert.equal(result.outcome, "DONE", result.report);
  assert.deepEqual(planned, ["sweep-pharma_a-us sweep-agent Clear the pending sample requests for HCP-1001 and HCP-1004. This plan is for HCP-1001."]);
  assert.match(result.report, /covers HCP-1001\./);
  assert.equal((await generations("pick-doctors")).length, 1);
});

test("an instruction loses its patient identifiers before the picker, the planner or the report reads it", async () => {
  const { desk, planned } = countingDesk();
  const result = await sweepOf(desk)({ tenantId: "pharma_a", today: "2026-11-23", runId: "live", instruction: "Follow up with HCP-1001 on MRN-77310, reply to pat.lee@example.com." });
  const sent = (await generations("pick-doctors")).map((generation) => generation.input);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /HCP-1001/, "the span holds what the picker was sent");
  for (const text of [...sent, ...planned, result.report]) assert.doesNotMatch(text, /77310|pat\.lee@example\.com/);
  assert.match(planned[0] ?? "", /\[record number removed\]/);
});

test("the budget is read before every step, so the step that would go over never starts", async () => {
  let spent = 0;
  // Each draft or plan costs 0.3 USD and the budget is 0.5: step 1 redrafts A-01 (0.3), step 2
  // picks the doctors, step 3 plans the first one (0.6), so step 4 never starts.
  const { desk, asked, planned } = countingDesk(async () => void (spent += 0.3));
  const result = await sweepOf(desk, async () => spent)({ tenantId: "pharma_a", today: "2027-03-02", runId: "live", instruction: "Clear the pending sample requests for HCP-1001 and HCP-1003." });
  assert.equal(result.outcome, "BUDGET_STOP", result.report);
  assert.deepEqual([asked.length, planned.length, result.steps], [1, 1, 3]);
  assert.match(result.report, /stopped before step 4/);
});

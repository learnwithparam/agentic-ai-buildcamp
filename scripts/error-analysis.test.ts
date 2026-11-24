import { test } from "node:test";
import assert from "node:assert/strict";
import { TRAFFIC } from "./error-analysis-traffic";
import { checkTraffic, parentFirst, readTraffic } from "./seed-error-analysis-traces";
import { assertAnnotationTemplates } from "./seed-error-analysis-annotations";

test("every error-analysis question has one recorded turn with one root", () => {
  const recorded = readTraffic();
  checkTraffic(recorded);
  assert.throws(() => checkTraffic(recorded.slice(1)), /do not match the questions/);
  const swapped = recorded.map((turn, index) => (index === 0 ? { ...turn, spans: recorded[1].spans } : turn));
  assert.throws(() => checkTraffic(swapped), /recorded for another question/);
});

test("open-coding notes never name a failure mode", () => {
  assertAnnotationTemplates();
  const note = TRAFFIC[0].note;
  TRAFFIC[0].note = "This is an off-label answer.";
  try {
    assert.throws(() => assertAnnotationTemplates(), /names a failure mode/);
  } finally {
    TRAFFIC[0].note = note;
  }
});

test("replay creates every parent before its children", () => {
  // The recorder lists a span when it ends, so a child comes before its parent.
  for (const turn of readTraffic()) {
    const seen = new Set<string>();
    for (const span of parentFirst(turn.spans)) {
      if (span.parentId) assert.ok(seen.has(span.parentId), `${turn.id}: ${span.name} came before its parent`);
      seen.add(span.id);
    }
  }
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { alignScoreboard } from "./align-scoreboard";
import { checkScoreboard, slices } from "./scoreboard";

// This file and align-scoreboard.ts stay on main, like the sync script that runs them.
test("a table from before a slice existed gets that column as dashes, every other cell stays under its slice", () => {
  const all = slices();
  const dropped = all[all.length - 2];
  const kept = all.filter((slice) => slice !== dropped);
  const oldRow = `| 07 | Old | 2/2 | ${kept.map((slice) => (slice === all[0] ? "1/1" : slice === all[all.length - 1] ? "1/1" : "-")).join(" | ")} | [run](http://run) |`;
  const old = `# Scoreboard\n\nText.\n\n| Chapter | Change | Passed | ${kept.join(" | ")} | Run |\n|---|\n${oldRow}\n`;
  assert.notDeepEqual(checkScoreboard(old), []);
  const aligned = alignScoreboard(old);
  assert.deepEqual(checkScoreboard(aligned), []);
  const cells = aligned.split("\n").find((line) => line.startsWith("| 07"))!.split("|").map((cell) => cell.trim());
  assert.equal(cells[4], "1/1");
  assert.equal(cells[4 + all.indexOf(dropped)], "-");
  assert.equal(cells[4 + all.length - 1], "1/1");
  assert.equal(alignScoreboard(aligned), aligned, "aligning twice changes nothing");
});

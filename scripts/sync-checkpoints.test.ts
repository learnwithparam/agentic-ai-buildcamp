import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const SCRIPT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "sync-checkpoints.sh");

// The sync script lives on main only, so on a checkpoint tag there is nothing to check.
test("the checkpoint sync defaults to the fetched origin/main and verifies every tag", { skip: !existsSync(SCRIPT) }, () => {
  const script = readFileSync(SCRIPT, "utf8");
  // A local main can be far behind; syncing from it rebuilt tag 00 from an old tree once.
  assert.doesNotMatch(script, /SOURCE_REF="\$\{SOURCE_REF:-main\}"/);
  assert.match(script, /git fetch -q origin main\n\s*SOURCE_REF=origin\/main/);
  // --verify runs the check before the "already in sync" skip, so an unmoved tag is checked too.
  const verify = script.indexOf('if [[ "$VERIFY" -eq 1 ]]; then\n    echo "    npm run check"');
  const skip = script.indexOf('echo "    already in sync with $SOURCE_REF"');
  assert.ok(verify > 0 && skip > verify, "--verify must run npm run check before a tag in sync is skipped");
});

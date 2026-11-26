#!/usr/bin/env bash
# Bring every canonical checkpoint tag in line with origin/main (or SOURCE_REF).
#
# Each tag gets SOURCE_REF's tree, except the milestone files listed in
# milestone_files(). Those keep the tag's own code, so each step still starts
# where its lesson expects (for example, no tracing before 02). Inside a
# milestone file, regions between
#   // checkpoint-sync:begin <name>
#   // checkpoint-sync:end <name>
# are still copied from SOURCE_REF, so shared content such as the system
# prompt reaches every tag.
#
# Usage (from repo root, clean working tree):
#   ./scripts/sync-checkpoints.sh                    # update tags locally
#   ./scripts/sync-checkpoints.sh --verify           # also run npm run check on every tag
#   ./scripts/sync-checkpoints.sh --verify --push    # then force-push moved tags
#
# --push first runs scripts/measures.ts --release: no tag is published while a row in
# docs/measures.md is pending or misses its target.
set -euo pipefail

# The run checks out each tag, which rewrites this file on disk. Bash reads a
# script as it runs, so the whole body sits in one group that is parsed first.
{

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

PUSH=0
VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --verify) VERIFY=1 ;;
    *) echo "Unknown option: $arg" >&2; exit 1 ;;
  esac
done

if [[ "$PUSH" -eq 1 ]]; then
  echo "==> measures (release)"
  npx tsx scripts/measures.ts --release
fi

TAGS=(
  checkpoint/00-setup
  checkpoint/01-base-app
  checkpoint/02-tracing
  checkpoint/03-prompt-management
  checkpoint/04-monitoring
  checkpoint/05-dataset
  checkpoint/06-experiments
  checkpoint/07-evaluation
  checkpoint/08-midpoint
  checkpoint/09-advanced-evals
  checkpoint/10-ai-gateway
  checkpoint/11-sign-in
  checkpoint/12-mcp-sandbox
  checkpoint/13-durable-review
  checkpoint/14-content-agents
  checkpoint/15-a2a
  checkpoint/16-events
  checkpoint/17-autonomy
  checkpoint/18-release-gate
  checkpoint/19-cli
  checkpoint/20-rag
  checkpoint/21-citations
  checkpoint/22-insights
  checkpoint/23-full-run
)

# Files whose code is what the next lesson changes. Add a file here when a
# lesson starts editing it; remove it once no earlier tag differs from main.
# A milestone file the tag does not have stays absent on it.
# Lesson 10 moves every model call behind src/server/gateway.ts; the files it changes and
# the gateway itself (GATEWAY_FILES) stay as they were on tags before it.
GATEWAY_FILES="src/server/routes.ts scripts/judge/faithfulness.ts src/server/gateway.ts src/server/gateway.test.ts"
# Lesson 11 signs doctors in through Keycloak and asks OpenFGA what each may read; the files it
# changes and adds (AUTH_FILES) stay as they were on tags before it, so those still run with no
# Keycloak, OpenFGA or Postgres.
AUTH_FILES="src/server/app.ts src/server/auth.ts src/server/auth.test.ts src/server/db.ts src/server/env.ts
  src/server/graph.ts src/server/graph.test.ts src/server/index.ts src/server/labels.ts src/server/labels.test.ts
  src/server/medinfo-agent.ts src/server/migrations/001_sessions.sql src/server/permissions.ts
  src/server/permissions.test.ts src/server/routes.ts src/server/sessions.ts src/server/sessions.test.ts
  src/server/tools.ts src/server/trace-identity.test.ts src/server/users.ts
  src/client/App.tsx src/client/chat/Thread.tsx src/client/chat/api.ts src/client/chat/suggestions.ts
  src/client/chat/suggestions.test.ts src/client/styles/app.css
  scripts/run-dataset.ts scripts/fga-model.ts scripts/fga-model.test.ts scripts/identity-setup.ts scripts/identity-smoke.ts"
# Lesson 12 opens an MCP door for coding agents and runs Langfuse code evaluators in our own
# sandbox; the files it changes and adds (MCP_FILES) stay as they were on tags before it, so
# lesson 04 still runs evaluators with insecure-local.
MCP_FILES="src/server/mcp.ts src/server/mcp.test.ts src/server/app.ts src/server/auth.ts scripts/identity-setup.ts
  .mcp.json .claude/skills/hcp-labels/SKILL.md langfuse/workshop.override.yml scripts/langfuse-code-eval.ts
  src/executor/sandbox.ts src/executor/server.ts src/executor/worker.ts src/executor/planted.ts
  src/executor/executor.test.ts src/executor/package.json src/executor/package-lock.json
  src/executor/Dockerfile src/executor/.dockerignore"
# Lesson 13 sorts every message into a risk tier, keeps threads in Postgres and sends drafts and
# adverse events to a reviewer inbox; the files it changes and adds (TIER_FILES) stay as they
# were on tags before it, so lesson 12 still approves a draft in the chat, from memory.
TIER_FILES="src/server/tiers.ts src/server/tiers.test.ts src/server/phi.ts src/server/reviews.ts
  src/server/inbox.test.ts src/server/durable.test.ts src/server/test-desk.ts src/server/migrations/002_reviews.sql
  src/server/graph.ts src/server/graph.test.ts src/server/medinfo-agent.ts src/server/app.ts src/server/index.ts
  src/server/routes.ts src/server/auth.ts src/server/auth.test.ts src/server/mcp.test.ts src/server/users.ts
  src/server/permissions.ts src/server/permissions.test.ts src/server/trace-identity.test.ts src/shared/messages.ts
  src/client/App.tsx src/client/chat/Thread.tsx src/client/chat/api.ts src/client/styles/app.css
  src/client/inbox/Inbox.tsx src/client/inbox/format.ts
  infra/openfga/model.fga infra/openfga/model.fga.yaml scripts/fga-model.ts scripts/identity-setup.ts
  scripts/prompt-variants.ts scripts/prompt-variants.test.ts scripts/run-dataset.ts"
# Lesson 14 adds a fact-checker and an outreach planner on the same base; the files it changes and
# adds (CONTENT_FILES) stay as they were on tags before it, so lesson 13's inbox has two kinds of item.
CONTENT_FILES="src/server/content/records.ts src/server/content/fact-check.ts src/server/content/outreach.ts
  src/server/content/content.test.ts src/server/content/content.live.ts scripts/live-spans.ts scripts/no-model-call.ts
  src/server/migrations/003_content_reviews.sql src/server/migrations/004_review_requests.sql
  src/client/content/Editor.tsx src/client/content/Outreach.tsx
  src/server/graph.ts src/server/graph.test.ts src/server/inbox.test.ts src/server/index.ts src/server/permissions.ts
  src/server/reviews.ts src/server/routes.ts src/server/test-desk.ts src/server/users.ts
  src/client/App.tsx src/client/chat/api.ts src/client/inbox/Inbox.tsx src/client/styles/app.css
  infra/openfga/model.fga infra/openfga/model.fga.yaml scripts/fga-model.ts scripts/identity-setup.ts
  scripts/hcp-cases.ts scripts/seed-dataset.ts scripts/run-dataset.ts scripts/scoreboard.ts scripts/scoreboard.test.ts
  package.json package-lock.json docs/scoreboard.md"
# Lesson 15 puts both agents behind A2A servers and adds the agent that hands work to them; the files
# it changes and adds (A2A_FILES) stay as they were on tags before it, so lesson 14 still calls each
# agent as a function.
A2A_FILES="docs/scoreboard.md package-lock.json package.json scripts/a2a-runner.ts scripts/hcp-cases.ts
  scripts/run-dataset.ts scripts/scoreboard.test.ts scripts/seed-dataset.ts src/client/App.tsx
  src/client/chat/api.ts src/client/content/Handoffs.tsx src/client/inbox/Inbox.tsx
  src/server/a2a/a2a.test.ts src/server/a2a/cards.ts src/server/a2a/executors.ts
  src/server/a2a/handoff.ts src/server/a2a/server.ts src/server/a2a/tasks.ts src/server/app.ts
  src/server/auth.ts src/server/content/fact-check.ts src/server/content/outreach.ts
  src/server/inbox.test.ts src/server/index.ts src/server/migrations/005_a2a_tasks.sql
  src/server/routes.ts src/server/test-desk.ts"
# Lesson 16 starts the agents from signed events through a pg-boss queue; the files it changes and
# adds (EVENT_FILES) stay as they were on tags before it, so lesson 15 has no webhook or Events page.
EVENT_FILES="docs/scoreboard.md package-lock.json package.json scripts/events-runner.ts scripts/events-send.ts
  scripts/hcp-cases.ts scripts/identity-setup.ts scripts/run-dataset.ts scripts/seed-dataset.ts
  src/client/App.tsx src/client/chat/api.ts src/client/content/Events.tsx src/server/a2a/a2a.test.ts
  src/server/app.ts src/server/content/records.ts src/server/events/events.test.ts src/server/events/events.ts
  src/server/events/handlers.ts src/server/events/send.ts src/server/events/store.ts src/server/events/webhook.ts
  src/server/graph.ts src/server/inbox.test.ts src/server/index.ts
  src/server/medinfo-agent.ts
  src/server/migrations/006_events.sql src/server/reviews.ts src/server/routes.ts src/server/test-desk.ts
  src/server/tools.ts src/server/trace-identity.test.ts src/server/users.ts"
# Lesson 17 adds the nightly sweep with its budget and kill switch; the files it changes and adds
# (AUTO_FILES) stay as they were on tags before it, so lesson 16 has no sweep or Sweep page.
AUTO_FILES="docs/scoreboard.md infra/openfga/model.fga infra/openfga/model.fga.yaml scripts/hcp-cases.ts
  scripts/run-dataset.ts scripts/seed-dataset.ts scripts/sweep-runner.ts src/client/App.tsx src/client/chat/api.ts
  src/client/content/Sweep.tsx src/client/styles/app.css src/server/a2a/a2a.test.ts src/server/auto/limits.ts
  src/server/auto/queue.ts src/server/auto/sweep.test.ts src/server/auto/sweep.ts src/server/events/handlers.ts
  src/server/events/store.ts src/server/inbox.test.ts src/server/index.ts src/server/migrations/007_sweep.sql
  src/server/permissions.ts src/server/routes.ts src/server/test-desk.ts src/server/users.ts
  src/server/a2a/a2a-harness.ts src/server/a2a/a2a.live.ts src/server/auto/counting-desk.ts src/server/auto/sweep.live.ts"
# Lesson 18 adds the release gate and its pre-push hook, and moves the case runner into
# scripts/experiment.ts; the files it changes and adds (GATE_FILES) stay as they were on tags before it.
GATE_FILES=".githooks/pre-push docs/scoreboard.md package.json scripts/experiment.ts scripts/release-gate.test.ts
  scripts/release-gate.ts scripts/run-dataset.ts src/server/medinfo-agent.ts"
# Lesson 19 adds the medinfo CLI, its Keycloak client and the route that says where to sign in; the
# files it changes and adds (CLI_FILES) stay as they were on tags before it, so lesson 18 has no CLI.
CLI_FILES="package.json package-lock.json scripts/identity-setup.ts src/server/auth.ts src/server/auth.test.ts
  src/server/inbox.test.ts src/client/chat/api.ts src/shared/sse.ts src/shared/messages.ts src/cli/api.ts
  src/cli/cli.test.ts src/cli/config.ts src/cli/index.tsx src/cli/session.ts src/cli/turn.ts src/cli/ui.tsx"
# Lesson 20 reads the label PDFs through Docling into pgvector; the files it changes and adds
# (RAG_FILES) stay as they were on tags before it, so lesson 19 still searches by keyword.
RAG_FILES="docs/scoreboard.md package.json package-lock.json scripts/experiment.ts scripts/rag-ingest.ts
  scripts/rag-setup.ts src/server/index.ts src/server/tools.ts src/server/migrations/008_label_chunks.sql
  src/server/rag/extract.ts src/server/rag/ingest.ts src/server/rag/rag.test.ts src/server/rag/rag.live.ts src/server/rag/search.ts
  src/server/rag/store.ts src/server/rag/fixtures/cardionex-clarion-hf-trial.docling.json
  src/server/rag/fixtures/cardionex-clarion-hf-trial.docling.md src/server/rag/fixtures/cardionex-uspi-v2.docling.json"
# Lesson 21 checks every answer's citations before it is sent; the files it changes and adds
# (CITE_FILES) stay as they were on tags before it, so lesson 20's answer goes out unchecked.
CITE_FILES="docs/scoreboard.md package.json scripts/citations-audit.ts scripts/citations-audit.test.ts
  src/server/citations.ts src/server/citations.test.ts src/server/citations.fixtures.json src/server/graph.ts
  src/server/graph.test.ts src/server/durable.test.ts src/server/medinfo-agent.ts
  scripts/citations-replay.ts scripts/citations-replay.test.ts data/evidence/citations-replay.json scripts/no-fake-model.test.ts"
# Lesson 22 adds the insights agent over sales data. Its files (BI_FILES) stay as they were on
# tags before it, so lesson 21 has no sales table, no analyst role and no /insights page.
# npm run setup (scripts/setup.ts) runs every lesson's scripts, so it exists only from lesson 22 on.
# npm run doctor (scripts/doctor.ts) checks the stack setup builds, so it follows setup.
BI_FILES=".github/start-test-services.sh docs/scoreboard.md infra/docker-compose.yml
  infra/openfga/model.fga infra/openfga/model.fga.yaml infra/postgres/init/02-bi-roles.sh package-lock.json package.json
  scripts/bi-setup.ts scripts/experiment.ts scripts/fga-model.ts scripts/hcp-cases.ts
  scripts/identity-setup.ts scripts/identity-smoke.ts scripts/setup.ts scripts/setup.test.ts scripts/doctor.ts scripts/doctor.test.ts src/client/App.tsx src/client/chat/api.ts
  src/client/insights/Insights.tsx src/client/styles/app.css src/server/a2a/a2a-harness.ts
  src/server/auth.ts src/server/bi/agent.ts src/server/bi/bi.test.ts src/server/bi/load.ts
  src/server/bi/query.ts src/server/env.ts src/server/inbox.test.ts src/server/index.ts
  src/server/mcp.ts src/server/migrations/009_sales.sql src/server/permissions.ts
  src/server/routes.ts src/server/test-desk.ts src/server/users.ts src/client/nav.ts src/client/nav.test.ts"
# The demo fixes after lesson 23 (DESK_FILES): one prompt per company, a router that sorts the latest
# message, search by country, the run record under each answer and in the review queue. They use
# lesson 21's citation check and lesson 22's roles, so tags before 22 keep their own copies.
# labels.ts is in no list from lesson 11 on: every tag reads the new label data, and only main's copy reads it right.
# The same holds from lesson 20 on for rag/extract.ts and the Docling fixtures: they read the new label PDFs.
DESK_FILES=".claude/skills/hcp-labels/SKILL.md scripts/citations-replay.ts scripts/demo-turns.ts
  scripts/demo-users.test.ts scripts/flows-capture.ts scripts/flows.test.ts scripts/flows.ts
  scripts/identity-setup.ts scripts/identity-smoke.ts scripts/open-questions.ts
  scripts/prompt-variants.test.ts scripts/prompt-variants.ts scripts/rag-fixtures.ts scripts/setup.ts
  scripts/sign-in.ts src/cli/cli.test.ts src/cli/turn.test.ts src/cli/turn.ts src/client/App.tsx
  src/client/chat/RunSteps.tsx src/client/chat/Thread.tsx src/client/chat/api.ts
  src/client/chat/parts.tsx src/client/content/Events.tsx src/client/inbox/Inbox.tsx
  src/client/styles/app.css src/server/citations.test.ts src/server/citations.ts
  src/server/desk-prompt.test.ts src/server/desk-prompt.ts src/server/gateway.test.ts
  src/server/gateway.ts src/server/graph.ts src/server/inbox.test.ts
  src/server/mcp.test.ts src/server/mcp.ts src/server/medinfo-agent.ts
  src/server/migrations/010_review_run.sql src/server/permissions.ts src/server/rag/rag.test.ts
  src/server/rag/search.ts src/server/reviews.ts src/server/tiers.test.ts src/server/tiers.ts
  src/server/tools.ts src/server/trace-identity.test.ts src/server/trace-shape.test.ts
  src/shared/run.test.ts src/shared/run.ts"
milestone_files() {
  case "$1" in
    checkpoint/00-setup | checkpoint/01-base-app | checkpoint/02-tracing)
      echo "src/server/index.ts src/server/medinfo-agent.ts src/server/tools.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES $TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/03-prompt-management)
      echo "src/server/medinfo-agent.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES $TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    # Lessons 06 and 07 run the dataset with the correctness judge; lesson 09 replaces it.
    checkpoint/04-* | checkpoint/05-* | checkpoint/06-* | checkpoint/07-* | checkpoint/08-* | checkpoint/09-*)
      echo "src/server/medinfo-agent.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES $TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/10-*)
      echo "$AUTH_FILES $MCP_FILES $TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/11-*)
      echo "$MCP_FILES $TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/12-*)
      echo "$TIER_FILES $CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/13-*)
      echo "$CONTENT_FILES $A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/14-*)
      echo "$A2A_FILES $EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/15-*)
      echo "$EVENT_FILES $AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/16-*)
      echo "$AUTO_FILES $GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/17-*)
      echo "$GATE_FILES $CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/18-*)
      echo "$CLI_FILES $RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/19-*)
      echo "$RAG_FILES $CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/20-*)
      echo "$CITE_FILES $BI_FILES $DESK_FILES"
      ;;
    checkpoint/21-*)
      echo "$BI_FILES $DESK_FILES"
      ;;
    *)
      echo ""
      ;;
  esac
}

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "Working tree must be clean before syncing checkpoints." >&2
  exit 1
fi

# The default is the merged main on GitHub, fetched now. A local main can be weeks behind, and
# syncing from it would rebuild every tag from an old tree.
if [[ -z "${SOURCE_REF:-}" ]]; then
  git fetch -q origin main
  SOURCE_REF=origin/main
fi
if ! git rev-parse --verify "$SOURCE_REF^{commit}" >/dev/null 2>&1; then
  echo "Missing source ref: $SOURCE_REF" >&2
  exit 1
fi
SOURCE_SHA="$(git rev-parse --short "$SOURCE_REF")"

START_REF="$(git symbolic-ref -q --short HEAD || git rev-parse HEAD)"
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/checkpoint-sync.XXXXXX")"
cleanup() {
  git checkout -q -f "$START_REF" >/dev/null 2>&1 || true
  rm -rf "$STAGE"
}
trap cleanup EXIT

mkdir -p "$STAGE/source" "$STAGE/keep"
git archive "$SOURCE_REF" | tar -x -C "$STAGE/source"
# The workflow, this script and the scoreboard alignment only run on main. A tag without them
# stays clean; the alignment is copied in for one step below and removed again.
cp "$STAGE/source/scripts/align-scoreboard.ts" "$STAGE/align-scoreboard.ts"
rm -rf "$STAGE/source/.github" "$STAGE/source/scripts/sync-checkpoints.sh" \
  "$STAGE/source/scripts/align-scoreboard.ts" "$STAGE/source/scripts/align-scoreboard.test.ts"

sync_regions() {
  python3 - "$1" "$2" <<'PY'
import re, sys

source_path, target_path = sys.argv[1], sys.argv[2]
pattern = re.compile(
    r"^[ \t]*// checkpoint-sync:begin (\S+)\n.*?^[ \t]*// checkpoint-sync:end \1\n",
    re.S | re.M,
)
source = open(source_path).read()
target = open(target_path).read()
regions = {m.group(1): m.group(0) for m in pattern.finditer(source)}
target_names = {m.group(1) for m in pattern.finditer(target)}
missing = sorted(set(regions) - target_names)
if missing:
    sys.exit(f"{target_path}: missing checkpoint-sync region(s) {', '.join(missing)}")
target = pattern.sub(lambda m: regions.get(m.group(1), m.group(0)), target)
open(target_path, "w").write(target)
PY
}

MOVED=()
PREVIOUS=""
for tag in "${TAGS[@]}"; do
  # A new lesson's tag starts from the tag before it, so it inherits that step's
  # milestone files, then takes SOURCE_REF's tree like every other tag.
  if ! git rev-parse --verify "refs/tags/$tag" >/dev/null 2>&1; then
    git tag "$tag" "${PREVIOUS:-$SOURCE_REF}^{commit}"
    MOVED+=("refs/tags/$tag")
    echo "    created $tag from ${PREVIOUS:-$SOURCE_REF}"
  fi
  PREVIOUS="refs/tags/$tag"

  echo "==> $tag"
  git checkout -q -f --detach "refs/tags/$tag"

  keep_files="$(milestone_files "$tag")"
  rm -rf "$STAGE/keep" && mkdir -p "$STAGE/keep"
  absent=""
  for file in $keep_files; do
    if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
      absent="$absent $file"
      continue
    fi
    mkdir -p "$STAGE/keep/$(dirname "$file")"
    git show "HEAD:$file" >"$STAGE/keep/$file"
  done

  git ls-files -z | grep -zv '^\.github/' | xargs -0 rm -f
  cp -a "$STAGE/source/." .

  for file in $absent; do
    rm -f "$file"
  done
  for file in $keep_files; do
    [[ " $absent " == *" $file "* ]] && continue
    cp "$STAGE/keep/$file" "$file"
    if [[ -f "$STAGE/source/$file" ]]; then
      sync_regions "$STAGE/source/$file" "$file"
    fi
  done

  # A tag keeps its own scoreboard, but the dataset is shared, so a slice added later is a new
  # column there too: the tag's rows get a dash in it.
  # It runs inside the tag so it reads that tag's own header (headerRow from scripts/scoreboard.ts).
  cp "$STAGE/align-scoreboard.ts" scripts/align-scoreboard.ts
  npx tsx scripts/align-scoreboard.ts
  rm scripts/align-scoreboard.ts

  git add -A
  # --verify checks every tag, moved or not: a tag already in sync is still what a learner checks out.
  if [[ "$VERIFY" -eq 1 ]]; then
    echo "    npm run check"
    npm run -s check
  fi
  if git diff --cached --quiet; then
    echo "    already in sync with $SOURCE_REF"
    continue
  fi

  git commit -q -m "$(cat <<MSG
Sync checkpoint with ${SOURCE_REF} (${SOURCE_SHA})

Takes the ${SOURCE_REF} tree, except the milestone files this step still
starts from: ${keep_files:-none}. Shared checkpoint-sync regions inside
those files come from ${SOURCE_REF} too.
MSG
)"

  git tag -f "$tag" HEAD >/dev/null
  [[ " ${MOVED[*]-} " == *" refs/tags/$tag "* ]] || MOVED+=("refs/tags/$tag")
  echo "    updated $(git rev-parse --short HEAD)"
done

if [[ "${#MOVED[@]}" -eq 0 ]]; then
  echo "All checkpoint tags already match $SOURCE_REF."
  exit 0
fi

if [[ "$PUSH" -eq 1 ]]; then
  git push --atomic --force origin "${MOVED[@]}"
  echo "Pushed ${#MOVED[@]} tag(s)."
else
  echo "Updated ${#MOVED[@]} tag(s) locally. Re-run with --push to publish them."
fi
exit
}

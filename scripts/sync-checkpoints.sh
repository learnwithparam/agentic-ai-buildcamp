#!/usr/bin/env bash
# Bring every canonical checkpoint tag in line with main (or SOURCE_REF).
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
#   ./scripts/sync-checkpoints.sh --verify           # also run npm run check on each tag
#   ./scripts/sync-checkpoints.sh --verify --push    # then force-push moved tags
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
milestone_files() {
  case "$1" in
    checkpoint/00-setup | checkpoint/01-base-app | checkpoint/02-tracing)
      echo "src/server/index.ts src/server/medinfo-agent.ts src/server/tools.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES"
      ;;
    checkpoint/03-prompt-management)
      echo "src/server/medinfo-agent.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES"
      ;;
    # Lessons 06 and 07 run the dataset with the correctness judge; lesson 09 replaces it.
    checkpoint/04-* | checkpoint/05-* | checkpoint/06-* | checkpoint/07-* | checkpoint/08-* | checkpoint/09-*)
      echo "src/server/medinfo-agent.ts scripts/run-dataset.ts $GATEWAY_FILES $AUTH_FILES $MCP_FILES"
      ;;
    checkpoint/10-*)
      echo "$AUTH_FILES $MCP_FILES"
      ;;
    checkpoint/11-*)
      echo "$MCP_FILES"
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

SOURCE_REF="${SOURCE_REF:-main}"
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
# The workflow and this script only run on main. A tag without them stays clean.
rm -rf "$STAGE/source/.github" "$STAGE/source/scripts/sync-checkpoints.sh"

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

  git add -A
  if git diff --cached --quiet; then
    echo "    already in sync with $SOURCE_REF"
    continue
  fi

  if [[ "$VERIFY" -eq 1 ]]; then
    echo "    npm run check"
    npm run -s check
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

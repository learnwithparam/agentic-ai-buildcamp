#!/usr/bin/env bash
# Bring every canonical checkpoint tag in line with origin/main (or SOURCE_REF).
#
# Tag N is the start of lesson N. It holds the files the lessons before N added, each at the
# version those lessons left, and nothing of lesson N. scripts/lesson-files.json says, for every
# file on main, the lesson that adds it and the lessons that change it (scripts/lesson-tags.ts
# turns that into a plan per tag). A file's newest version is main's copy. An older version is the
# file as main stood when the lesson before the next change ended (the manifest's lessonEnd). The
# untraced app of lessons 0 to 2 has no commit, so a tag keeps the copy it has. Inside a kept
# older version, regions between
#   // checkpoint-sync:begin <name>
#   // checkpoint-sync:end <name>
# are still copied from SOURCE_REF, so shared content such as the system prompt reaches every tag.
# package.json keeps only the scripts whose files the tag holds, the dataset lock lists only the
# files the tag holds, and docs/coverage.md only the cases it holds.
#
# Usage (from repo root, clean working tree, full history: git fetch --unshallow):
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

mkdir -p "$STAGE/source"
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
  # A new lesson's tag starts from the tag before it, so a hand-cut version (lessons 0 to 2) has a
  # copy to keep, then it is rebuilt from the plan like every other tag.
  if ! git rev-parse --verify "refs/tags/$tag" >/dev/null 2>&1; then
    git tag "$tag" "${PREVIOUS:-$SOURCE_REF}^{commit}"
    MOVED+=("refs/tags/$tag")
    echo "    created $tag from ${PREVIOUS:-$SOURCE_REF}"
  fi
  PREVIOUS="refs/tags/$tag"

  echo "==> $tag"
  git checkout -q -f --detach "refs/tags/$tag"

  # The tag number is the two digits after "checkpoint/". The plan says where each file comes from.
  number="${tag#checkpoint/}"
  number=$((10#${number:0:2}))
  plan="$(npx tsx "$STAGE/source/scripts/lesson-tags.ts" plan "$number" "$STAGE/source/scripts/lesson-files.json")"

  # Build the tag's tree aside first: it reads this tag's own files and older commits, and the
  # next step removes the files on disk.
  rm -rf "$STAGE/tree" && mkdir -p "$STAGE/tree"
  older=""
  while IFS=$'\t' read -r file source; do
    [[ -z "$file" ]] && continue
    mkdir -p "$STAGE/tree/$(dirname "$file")"
    case "$source" in
      main)
        cp "$STAGE/source/$file" "$STAGE/tree/$file"
        ;;
      tag)
        if ! git cat-file -e "HEAD:$file" 2>/dev/null; then
          echo "$tag: $file is a hand-cut version and this tag has no copy to keep." >&2
          exit 1
        fi
        git show "HEAD:$file" >"$STAGE/tree/$file"
        older="$older $file"
        ;;
      commit\ *)
        ref="${source#commit }"
        if ! git show "$ref:$file" >"$STAGE/tree/$file" 2>/dev/null; then
          echo "$tag: $file is not in $ref. Fetch the full history (git fetch --unshallow), or fix scripts/lesson-files.json." >&2
          exit 1
        fi
        older="$older $file"
        ;;
    esac
  done <<<"$plan"
  for file in $older; do
    if [[ -f "$STAGE/source/$file" ]]; then
      sync_regions "$STAGE/source/$file" "$STAGE/tree/$file"
    fi
  done
  # package.json, the dataset lock and the coverage table list only what the tag holds.
  npx tsx "$STAGE/source/scripts/lesson-tags.ts" derive "$STAGE/tree"

  git ls-files -z | xargs -0 rm -f
  cp -a "$STAGE/tree/." .

  # A tag keeps its own scoreboard, but the dataset is shared, so a slice added later is a new
  # column there too: the tag's rows get a dash in it.
  # It runs inside the tag so it reads that tag's own header (headerRow from scripts/scoreboard.ts).
  if [[ -f docs/scoreboard.md ]]; then
    cp "$STAGE/align-scoreboard.ts" scripts/align-scoreboard.ts
    npx tsx scripts/align-scoreboard.ts
    rm scripts/align-scoreboard.ts
  fi

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

Tag ${number} is the start of lesson ${number}: the files lessons before it added, from
${SOURCE_REF}, each at the version those lessons left (scripts/lesson-files.json). Files kept at
an older version, with their shared checkpoint-sync regions from ${SOURCE_REF}:${older:- none}.
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

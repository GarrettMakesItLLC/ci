#!/usr/bin/env bash
# Fixture test for file-failure-issue's file/close modes, run by
# .github/workflows/self-check.yml on every PR that touches this action.
#
# No network and no real repo: file.sh/close.sh run unmodified against a fake
# `gh` backed by an in-memory JSON array, so this exercises the actual dedupe
# and mode logic without filing anything in a real issue tracker. Covers the
# full lifecycle: file (creates) -> file again (comments, no dupe) -> close
# (closes) -> close again (no-op, no error).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

STATE="$WORK/state.json"
CALLS="$WORK/calls.log"
echo '[]' >"$STATE"
: >"$CALLS"

# --- fake `gh` -------------------------------------------------------------
# Emulates just enough of `gh api .../issues` (list), `gh issue create`,
# `gh issue comment`, `gh issue close` for file.sh/close.sh to run against,
# backed by a JSON array in $STATE. No network, no real repo.
# This mock re-implements gh's built-in --jq evaluation (gh bundles its own
# jq engine; it does not shell out to a system `jq` binary, so the real
# action never depends on one being installed). It hardcodes the one query
# lib.sh actually issues — filter by state, drop PRs, match by title — rather
# than interpreting the --jq string generically, since that's the only
# expression this repo's own code produces.
FAKE_GH="$WORK/gh"
cat >"$FAKE_GH" <<'GHEOF'
#!/usr/bin/env bash
set -euo pipefail
CALLS="$FIXTURE_CALLS"
echo "gh $*" >>"$CALLS"

if [ "$1" = "api" ]; then
  state_filter=""
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "-f" ] && [[ "${args[$((i + 1))]}" == state=* ]]; then
      state_filter="${args[$((i + 1))]#state=}"
    fi
  done
  STATE_FILTER="$state_filter" TITLE="$TITLE" FIXTURE_STATE="$FIXTURE_STATE" python3 - <<'PYEOF'
import json, os
state = json.load(open(os.environ["FIXTURE_STATE"]))
sf = os.environ["STATE_FILTER"]
title = os.environ["TITLE"]
match = [i for i in state if i["state"] == sf and i.get("pull_request") is None and i["title"] == title]
print(match[0]["number"] if match else "")
PYEOF
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  title=""
  for ((i = 0; i < $#; i++)); do
    if [ "${!i}" = "--title" ]; then
      next=$((i + 1))
      title="${!next}"
    fi
  done
  TITLE_ARG="$title" FIXTURE_STATE="$FIXTURE_STATE" python3 - <<'PYEOF'
import json, os
path = os.environ["FIXTURE_STATE"]
state = json.load(open(path))
num = len(state) + 1
state.append({"number": num, "title": os.environ["TITLE_ARG"], "state": "open", "pull_request": None})
json.dump(state, open(path, "w"))
print(f"https://github.com/o/r/issues/{num}")
PYEOF
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "comment" ]; then
  # Drain stdin when body comes via --body-file - (file.sh's recur path) so
  # the writer never sees SIGPIPE under `set -o pipefail`.
  if [[ " $* " == *" - "* ]]; then
    cat >/dev/null
  fi
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "close" ]; then
  num="$3"
  NUM_ARG="$num" FIXTURE_STATE="$FIXTURE_STATE" python3 - <<'PYEOF'
import json, os
path = os.environ["FIXTURE_STATE"]
state = json.load(open(path))
for i in state:
    if str(i["number"]) == os.environ["NUM_ARG"]:
        i["state"] = "closed"
json.dump(state, open(path, "w"))
PYEOF
  exit 0
fi

echo "fake gh: unhandled: $*" >&2
exit 1
GHEOF
chmod +x "$FAKE_GH"
export PATH="$WORK:$PATH"
export FIXTURE_STATE="$STATE"
export FIXTURE_CALLS="$CALLS"

# jq's `--jq` filter in lib.sh reads `env.TITLE` — the real `gh api --jq`
# reads env vars too, so the fake must expose the same one.
run_mode() {
  local mode="$1"
  local title="$2"
  local body_file="${3:-}"
  local comment="${4:-}"
  GITHUB_OUTPUT="$WORK/output"
  : >"$GITHUB_OUTPUT"
  GH_TOKEN=fake \
    TITLE="$title" \
    BODY_FILE="$body_file" \
    LABELS="ci-failure,type:bug" \
    DEDUPE_LABEL="" \
    COMMENT="$comment" \
    RUN_URL="https://example/run/1" \
    GITHUB_REPOSITORY="o/r" \
    GITHUB_OUTPUT="$GITHUB_OUTPUT" \
    "$REPO_ROOT/actions/file-failure-issue/$mode.sh"
  cat "$GITHUB_OUTPUT"
}

assert_state_open_count() {
  local expected="$1"
  local got
  got=$(python3 -c "import json,sys; print(len([i for i in json.load(open(sys.argv[1])) if i['state']=='open']))" "$STATE")
  if [ "$got" != "$expected" ]; then
    echo "FAIL: expected $expected open issue(s), got $got"
    cat "$STATE"
    exit 1
  fi
}

echo "$1" >"$WORK/body.md"

echo "== 1. file mode, nothing open -> creates =="
run_mode file "URGENT: og monitor failing" "$WORK/body.md"
assert_state_open_count 1

echo "== 2. file mode again, same title -> comments, no new issue =="
run_mode file "URGENT: og monitor failing" "$WORK/body.md"
assert_state_open_count 1

echo "== 3. close mode, matching title -> closes =="
run_mode close "URGENT: og monitor failing" "" "Fixed"
assert_state_open_count 0

echo "== 4. close mode again, nothing open -> no-op, no error =="
run_mode close "URGENT: og monitor failing" "" "Fixed"
assert_state_open_count 0

echo "ALL PASSED"

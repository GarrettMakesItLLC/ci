#!/usr/bin/env bash
# Fixture test for file-failure-issue's file/close modes, run by
# .github/workflows/self-check.yml on every PR that touches this action.
#
# No network and no real repo: file.sh/close.sh run unmodified against a fake
# `gh` backed by an in-memory JSON array, so this exercises the actual dedupe
# and mode logic without filing anything in a real issue tracker. Covers the
# full lifecycle: file (creates) -> file again (comments, no dupe) -> close
# (closes) -> close again (no-op, no error) — plus the dedupe-key path, where
# two different titles sharing a key must dedupe onto the same issue.
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
# `gh api --jq` is evaluated with the system `jq` over the open issues, so the
# REAL filter expressions in lib.sh run here, not a hardcoded re-implementation
# of them. `gh` bundles its own jq engine rather than shelling out, so the real
# action never depends on a system `jq`; this fixture does, and ubuntu-latest
# ships one. `--paginate` is a single page here.
FAKE_GH="$WORK/gh"
cat >"$FAKE_GH" <<'GHEOF'
#!/usr/bin/env bash
set -euo pipefail
CALLS="$FIXTURE_CALLS"
echo "gh $*" >>"$CALLS"

if [ "$1" = "api" ]; then
  state_filter=""
  jq_expr=""
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "-f" ] && [[ "${args[$((i + 1))]}" == state=* ]]; then
      state_filter="${args[$((i + 1))]#state=}"
    fi
    if [ "${args[$i]}" = "--jq" ]; then
      jq_expr="${args[$((i + 1))]}"
    fi
  done
  jq --arg s "$state_filter" 'map(select(.state == $s))' "$FIXTURE_STATE" | jq -r "$jq_expr"
  exit 0
fi

if [ "$1" = "issue" ] && [ "$2" = "create" ]; then
  title=""
  body_file=""
  args=("$@")
  for ((i = 0; i < ${#args[@]}; i++)); do
    if [ "${args[$i]}" = "--title" ]; then
      title="${args[$((i + 1))]}"
    fi
    if [ "${args[$i]}" = "--body-file" ]; then
      body_file="${args[$((i + 1))]}"
    fi
  done
  TITLE_ARG="$title" BODY_FILE_ARG="$body_file" FIXTURE_STATE="$FIXTURE_STATE" python3 - <<'PYEOF'
import json, os
path = os.environ["FIXTURE_STATE"]
state = json.load(open(path))
num = len(state) + 1
body_file = os.environ["BODY_FILE_ARG"]
body = open(body_file).read() if body_file and body_file != "-" else ""
state.append({"number": num, "title": os.environ["TITLE_ARG"], "state": "open", "pull_request": None, "body": body})
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

run_mode() {
  local mode="$1"
  local title="$2"
  local body_file="${3:-}"
  local comment="${4:-}"
  local dedupe_key="${5:-}"
  GITHUB_OUTPUT="$WORK/output"
  : >"$GITHUB_OUTPUT"
  GH_TOKEN=fake \
    TITLE="$title" \
    ADDITIONAL_TITLES="${ADDITIONAL_TITLES:-}" \
    TITLE_PREFIX="${TITLE_PREFIX:-}" \
    BODY_FILE="$body_file" \
    LABELS="ci-failure,type:bug" \
    DEDUPE_LABEL="" \
    DEDUPE_KEY="$dedupe_key" \
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

echo "== 5. file mode with dedupe-key, nothing open -> creates =="
run_mode file "nightly lane has gone quiet" "$WORK/body.md" "" "nightly-lane"
assert_state_open_count 1

echo "== 6. file mode, DIFFERENT title, SAME dedupe-key -> comments, no new issue =="
run_mode file "nightly lane is failing" "$WORK/body.md" "" "nightly-lane"
assert_state_open_count 1

echo "== 7. close mode with the same dedupe-key (different title again) -> closes =="
run_mode close "nightly lane recovered" "" "Fixed" "nightly-lane"
assert_state_open_count 0

# An issue with no marker: filed before the marker existed, or its body was
# rewritten by hand. Seeded straight into the state, as GitHub would hold it.
seed_issue() {
  TITLE_ARG="$1" BODY_ARG="$2" FIXTURE_STATE="$STATE" python3 - <<'PYEOF'
import json, os
path = os.environ["FIXTURE_STATE"]
state = json.load(open(path))
num = len(state) + 1
state.append({"number": num, "title": os.environ["TITLE_ARG"], "state": "open", "pull_request": None, "body": os.environ["BODY_ARG"]})
json.dump(state, open(path, "w"))
print(num)
PYEOF
}

assert_output_number() {
  local expected="$1" got
  got=$(sed -n 's/^number=//p' "$WORK/output")
  if [ "$got" != "$expected" ]; then
    echo "FAIL: expected number=$expected, got number=$got"
    cat "$STATE"
    exit 1
  fi
}

echo "== 8. file mode, open issue with the SAME title but NO marker -> comments on it, no new issue =="
legacy=$(seed_issue "Spend check did not come back clean" "## Owner action required (rewritten by hand, marker gone)")
assert_state_open_count 1
run_mode file "Spend check did not come back clean" "$WORK/body.md"
assert_output_number "$legacy"
assert_state_open_count 1

echo "== 9. close mode finds the marker-less issue by title -> closes it =="
run_mode close "Spend check did not come back clean" "" "Fixed"
assert_output_number "$legacy"
assert_state_open_count 0

echo "== 10. a marker match wins over a title match =="
seed_issue "uptime monitor alerts nobody" "no marker here" >/dev/null
run_mode file "uptime lane is red" "$WORK/body.md" "" "uptime-lane"
marked=$(python3 -c "import json,sys; print(max(i['number'] for i in json.load(open(sys.argv[1]))))" "$STATE")
run_mode file "uptime monitor alerts nobody" "$WORK/body.md" "" "uptime-lane"
assert_output_number "$marked"
assert_state_open_count 2

seed_labelled() {
  # An open issue under the ci-failure label, as GitHub would hold it. The fake
  # does not filter by label, so every seeded issue counts as labelled.
  seed_issue "$1" "${2:-no marker here}"
}

close_with() {
  ADDITIONAL_TITLES="$1" TITLE_PREFIX="$2" run_mode close "$3" "" "Fixed" "${4:-}"
}

echo "== 11. close mode, additional-titles: one call closes every named symptom =="
seed_labelled "Lane has gone quiet" >/dev/null
seed_labelled "Lane has gone quiet - refused before step 1" >/dev/null
seed_labelled "Unrelated lane has gone quiet" >/dev/null
before=$(python3 -c "import json,sys; print(len([i for i in json.load(open(sys.argv[1])) if i['state']=='open']))" "$STATE")
close_with "Lane has gone quiet - refused before step 1" "" "Lane has gone quiet"
assert_state_open_count $((before - 2))

echo "== 12. close mode, title-prefix: closes every issue carrying the prefix, leaves the rest =="
seed_labelled "Deploy failed: production (abc123)" >/dev/null
seed_labelled "Deploy failed: production (def456)" >/dev/null
open_now=$(python3 -c "import json,sys; print(len([i for i in json.load(open(sys.argv[1])) if i['state']=='open']))" "$STATE")
close_with "" "Deploy failed: production (" "No exact title matches"
assert_state_open_count $((open_now - 2))
if [ "$(sed -n 's/^numbers=//p' "$WORK/output" | wc -w)" -ne 2 ]; then
  echo "FAIL: expected numbers= to list the two closed issues"; cat "$WORK/output"; exit 1
fi

echo "== 13. regression: a title with a backslash and quotes still closes (a spliced jq program breaks on it) =="
tricky='Backup "nightly" failed: C:\\data\\x'
seed_labelled "$tricky" >/dev/null
open_now=$(python3 -c "import json,sys; print(len([i for i in json.load(open(sys.argv[1])) if i['state']=='open']))" "$STATE")
close_with "" "" "$tricky"
assert_state_open_count $((open_now - 1))

echo "== 14. an empty prefix and empty additional-titles match nothing extra =="
open_now=$(python3 -c "import json,sys; print(len([i for i in json.load(open(sys.argv[1])) if i['state']=='open']))" "$STATE")
close_with "" "" "A title nothing carries"
assert_state_open_count "$open_now"

echo "ALL PASSED"

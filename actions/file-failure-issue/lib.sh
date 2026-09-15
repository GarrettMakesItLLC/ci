#!/usr/bin/env bash
# Shared dedupe lookup for file-failure-issue's file and close modes.
#
# Requires on the caller's environment: `gh` authenticated via GH_TOKEN,
# GITHUB_REPOSITORY, and TITLE (read by the --jq expression via `env.TITLE`).
#
# The search index (`gh issue list --search`) lags real-time writes by
# minutes, so near-simultaneous runs can each miss the other's issue. List
# open issues by label via the REST endpoint instead — consistent reads, no
# staleness window — and paginate: a busy tracker can push an older open
# issue past the first page, and a missed match either files a duplicate
# (file mode) or leaves a resolved issue open forever (close mode).
find_existing_issue() {
  local label="$1"
  gh api "repos/$GITHUB_REPOSITORY/issues" \
    -X GET \
    -f state=open \
    -f labels="$label" \
    -f per_page=100 \
    --paginate \
    --jq '[.[] | select(.pull_request == null) | select(.title == env.TITLE)] | first | .number // empty'
}

# Defaults to the first entry of LABELS, so a caller that leads with a
# distinguishing label (e.g. `ci-failure`) needs no extra input. Close mode
# has no LABELS to apply, but still needs the same dedupe key the filer used
# to find the issue, so callers pass DEDUPE_LABEL explicitly there.
resolve_dedupe_label() {
  local labels="$1" dedupe_label="$2"
  if [ -n "$dedupe_label" ]; then
    echo "$dedupe_label"
    return
  fi
  IFS=',' read -ra names <<<"$labels"
  echo "${names[0]}"
}

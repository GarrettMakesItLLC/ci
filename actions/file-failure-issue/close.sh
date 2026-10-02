#!/usr/bin/env bash
#
# Close mode: the other half of file-failure-issue. Given the same dedupe
# label/title a caller used to file, find the open issue and close it. An
# issue left open after the failure is fixed inverts the signal — a tracker
# showing "this is broken" while the thing is green teaches people the alert
# means nothing, which is worse than no alert at all.
#
# Nothing open under that title is the NORMAL case: most runs are green and
# never filed anything, so this is a silent no-op, not an error.
#
# Env in: GH_TOKEN, TITLE, ADDITIONAL_TITLES, TITLE_PREFIX, LABELS, DEDUPE_LABEL,
#         DEDUPE_KEY, COMMENT, RUN_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$dir/lib.sh"

label="$(resolve_dedupe_label "$LABELS" "$DEDUPE_LABEL")"
marker="$(dedupe_marker "$TITLE" "${DEDUPE_KEY:-}")"
matches="$(find_close_candidates "$label" "$marker" "$TITLE" "${ADDITIONAL_TITLES:-}" "${TITLE_PREFIX:-}")"

if [ -z "$matches" ]; then
  echo "number=" >>"$GITHUB_OUTPUT"
  echo "numbers=" >>"$GITHUB_OUTPUT"
  echo "::notice title=Nothing to close::No open issue matching \"$TITLE\" under label \"$label\"."
  exit 0
fi

closed=()
while IFS= read -r number; do
  [ -n "$number" ] || continue
  gh issue comment "$number" --repo "$GITHUB_REPOSITORY" \
    --body "${COMMENT:-Resolved} as of $RUN_URL."
  gh issue close "$number" --repo "$GITHUB_REPOSITORY" --reason completed
  closed+=("$number")
  echo "::notice title=Closed issue::#$number"
done <<<"$matches"
echo "number=${closed[0]}" >>"$GITHUB_OUTPUT"
echo "numbers=${closed[*]}" >>"$GITHUB_OUTPUT"

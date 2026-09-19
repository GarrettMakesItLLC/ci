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
# Env in: GH_TOKEN, TITLE, LABELS, DEDUPE_LABEL, DEDUPE_KEY, COMMENT, RUN_URL,
#         GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$dir/lib.sh"

label="$(resolve_dedupe_label "$LABELS" "$DEDUPE_LABEL")"
marker="$(dedupe_marker "$TITLE" "${DEDUPE_KEY:-}")"
existing="$(find_existing_issue "$label" "$marker")"

if [ -z "$existing" ]; then
  echo "number=" >>"$GITHUB_OUTPUT"
  echo "::notice title=Nothing to close::No open issue titled \"$TITLE\" under label \"$label\"."
  exit 0
fi

gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" \
  --body "${COMMENT:-Resolved} as of $RUN_URL."
gh issue close "$existing" --repo "$GITHUB_REPOSITORY" --reason completed
echo "number=$existing" >>"$GITHUB_OUTPUT"
echo "::notice title=Closed issue::#$existing"

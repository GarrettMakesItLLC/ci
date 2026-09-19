#!/usr/bin/env bash
#
# File mode: open an issue for an unwatched automation failure, reusing an
# open match instead of duplicating. See actions/file-failure-issue/action.yml.
#
# Env in: GH_TOKEN, TITLE, BODY_FILE, LABELS, DEDUPE_LABEL, DEDUPE_KEY,
#         RUN_URL, GITHUB_REPOSITORY, GITHUB_OUTPUT.
set -euo pipefail

dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=./lib.sh
source "$dir/lib.sh"

if [ ! -f "$BODY_FILE" ]; then
  echo "::error title=Missing body file::$BODY_FILE does not exist."
  exit 1
fi

label="$(resolve_dedupe_label "$LABELS" "$DEDUPE_LABEL")"
marker="$(dedupe_marker "$TITLE" "${DEDUPE_KEY:-}")"
existing="$(find_existing_issue "$label" "$marker")"

if [ -n "$existing" ]; then
  {
    echo "Recurred — $RUN_URL"
    echo
    cat "$BODY_FILE"
  } | gh issue comment "$existing" --repo "$GITHUB_REPOSITORY" --body-file -
  echo "number=$existing" >>"$GITHUB_OUTPUT"
  echo "::notice title=Reused issue::#$existing already tracks this."
  exit 0
fi

args=()
IFS=',' read -ra names <<<"$LABELS"
for name in "${names[@]}"; do
  [ -n "$name" ] && args+=(--label "$name")
done

body_with_marker="$(mktemp)"
{
  echo "$marker"
  echo
  cat "$BODY_FILE"
} >"$body_with_marker"

url=$(gh issue create --repo "$GITHUB_REPOSITORY" \
  --title "$TITLE" --body-file "$body_with_marker" "${args[@]}")
number="${url##*/}"
echo "number=$number" >>"$GITHUB_OUTPUT"
echo "::notice title=Filed issue::$url"

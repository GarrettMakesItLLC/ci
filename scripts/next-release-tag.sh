#!/usr/bin/env bash
# Prints the immutable v1.N.M tag the next release of HEAD gets.
#
# The latest existing v1.N.M is the base. A `feat` commit since it bumps the minor, anything else
# bumps the patch; with no v1.N.M yet, the first is v1.0.0. Commit subjects are Conventional Commits
# (commitlint enforces it), so the log since the last tag already says which kind of change this is.
set -euo pipefail

latest="$(git tag -l 'v1.*.*' --sort=-v:refname | grep -E '^v1\.[0-9]+\.[0-9]+$' | head -n1 || true)"
if [ -z "$latest" ]; then
  echo "v1.0.0"
  exit 0
fi

IFS=. read -r _ minor patch <<<"${latest#v}"
if git log --format=%s "${latest}..HEAD" | grep -qE '^feat(\([^)]*\))?!?:'; then
  echo "v1.$((minor + 1)).0"
else
  echo "v1.${minor}.$((patch + 1))"
fi

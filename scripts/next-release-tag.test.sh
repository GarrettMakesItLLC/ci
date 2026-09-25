#!/usr/bin/env bash
# Fixture test for next-release-tag.sh against throwaway repos.
set -euo pipefail
script="$(cd "$(dirname "$0")" && pwd)/next-release-tag.sh"
fail=0

check() { # name expected
  local got
  got="$(bash "$script")"
  if [ "$got" = "$2" ]; then echo "ok   $1 -> $got"; else echo "FAIL $1: expected $2, got $got"; fail=1; fi
}

repo="$(mktemp -d)"
trap 'rm -rf "$repo"' EXIT
cd "$repo"
git init -q
git config user.email t@example.com
git config user.name t
commit() { git commit -q --allow-empty -m "$1"; }

commit "chore: start"
check "no v1.N.M yet" v1.0.0

git tag v1.0.0
commit "fix(x): repair"
check "fix since v1.0.0" v1.0.1

commit "feat(y): add"
check "feat since v1.0.0" v1.1.0

git tag v1.1.0
commit "feat!: breaking but still v1 line"
check "feat! bumps minor on the v1 line" v1.2.0

git tag v1.2.0
git tag v1.10.0 HEAD
commit "docs: note"
check "version sort, not lexical" v1.10.1

git tag v1 HEAD
git tag v1.x HEAD
check "ignores v1 and non-numeric tags" v1.10.1

exit "$fail"

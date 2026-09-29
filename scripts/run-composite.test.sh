#!/usr/bin/env bash
# run-composite.py must give a step the GITHUB_WORKSPACE a hosted runner would:
# the cwd when unset, the caller's value when set.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/actions/probe"
cat > "$tmp/actions/probe/action.yml" <<'Y'
name: probe
runs:
  using: composite
  steps:
    - shell: bash
      run: test "$GITHUB_WORKSPACE" = "$PWD"
Y
cd "$tmp"
real="$(pwd -P)"
(unset GITHUB_WORKSPACE; python3 "$here/run-composite.py" actions/probe >/dev/null)
GITHUB_WORKSPACE="$real" python3 "$here/run-composite.py" actions/probe >/dev/null
GITHUB_WORKSPACE=/somewhere/else python3 "$here/run-composite.py" actions/probe --expect fail >/dev/null
echo "run-composite.test: ok"

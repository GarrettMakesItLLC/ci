#!/usr/bin/env bash
# check-dependency-inventory passes its clean fixture and fails its drifted one.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
# The fail fixture is MEANT to exit non-zero, so each status is captured, never fatal.
set +e -uo pipefail
script=actions/check-dependency-inventory/check.mjs
common=(--doc-path doc.md --manifest-paths "packages/*/package.json" --workspace-prefixes "@fixture-scope/")

node "$script" "${common[@]}" --cwd actions/check-dependency-inventory/fixtures/pass
pass_status=$?
if [ "$pass_status" -ne 0 ]; then
  echo "::error::pass fixture should have exited 0, got $pass_status"
  exit 1
fi
echo "pass fixture: OK (exit 0, as expected)"

node "$script" "${common[@]}" --cwd actions/check-dependency-inventory/fixtures/fail
fail_status=$?
if [ "$fail_status" -eq 0 ]; then
  echo "::error::fail fixture should have exited non-zero (undocumented 'chalk'), got 0"
  exit 1
fi
echo "fail fixture: OK (exit $fail_status, as expected)"

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

# A manifest that matches --manifest-paths but is not valid JSON must fail, not be skipped.
node "$script" "${common[@]}" --cwd actions/check-dependency-inventory/fixtures/broken
broken_status=$?
if [ "$broken_status" -eq 0 ]; then
  echo "::error::broken fixture should have exited non-zero (unparseable manifest), got 0"
  exit 1
fi
echo "broken fixture: OK (exit $broken_status, as expected)"

# Zero declared dependencies fails by default and passes only when the repo says it has none.
node "$script" "${common[@]}" --cwd actions/check-dependency-inventory/fixtures/empty
empty_status=$?
if [ "$empty_status" -eq 0 ]; then
  echo "::error::empty fixture should have exited non-zero (0 dependencies checked), got 0"
  exit 1
fi
echo "empty fixture: OK (exit $empty_status, as expected)"

node "$script" "${common[@]}" --allow-empty true --cwd actions/check-dependency-inventory/fixtures/empty
allow_empty_status=$?
if [ "$allow_empty_status" -ne 0 ]; then
  echo "::error::empty fixture with --allow-empty true should have exited 0, got $allow_empty_status"
  exit 1
fi
echo "empty fixture with --allow-empty: OK (exit 0, as expected)"

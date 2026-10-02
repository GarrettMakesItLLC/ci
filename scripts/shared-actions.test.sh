#!/usr/bin/env bash
# Unit cases for check-dependency-licenses, check-migration-order, check-required-checks,
# check-vendored-copy and pr-body-lint, through the real scripts (the migration and
# vendored-copy suites also drive the CLI against temp git repos and files).
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
set -euo pipefail
cd "$(dirname "$0")/.."
node --test \
  actions/check-dependency-licenses/check.test.mjs \
  actions/check-migration-order/order.test.mjs \
  actions/check-required-checks/check.test.mjs \
  actions/check-vendored-copy/check.test.mjs \
  actions/pr-body-lint/lint.test.mjs
bash scripts/e2e-test-install-only.test.sh

#!/usr/bin/env bash
# cwv-judge: unit cases for the persistence rule, then the fixture sets through the real judge.mjs.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
set -euo pipefail
cd "$(dirname "$0")/.."
node --test actions/cwv-judge/judge.test.mjs

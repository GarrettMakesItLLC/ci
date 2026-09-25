#!/usr/bin/env bash
# The README is the consumer-facing contract: it must pin a tag, never @main.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
set -uo pipefail
if grep -nE "GarrettMakesItLLC/ci[^@]*@main" README.md CLAUDE.md; then
  echo "::error::docs must pin a version tag, never @main"
  exit 1
fi
echo "ok"

#!/usr/bin/env bash
# cwv-judge: unit cases for the persistence rule, route allowances, the over-floor annotation and
# the history stores, then the fixture sets through the real judge.mjs. Also cwv-measure's HTTP/2
# front, which carries no dependency and so runs without installing Lighthouse.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
set -euo pipefail
cd "$(dirname "$0")/.."
node --test actions/cwv-judge/judge.test.mjs actions/cwv-measure/h2-front.test.mjs

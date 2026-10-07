#!/usr/bin/env bash
# Every self-check.yml job must be waited for by `CI Success`, directly or through
# another job it needs. A job outside that set runs on every PR but cannot block a
# merge, so the gate it proves can regress unseen. `v1-current` is exempt: it does
# not run on pull_request, and `ci-success` is the aggregate itself.
set -euo pipefail
workflow="${1:-.github/workflows/self-check.yml}"
python3 - "$workflow" <<'PY'
import sys
import yaml

jobs = yaml.safe_load(open(sys.argv[1]))["jobs"]

def needs(name):
    n = jobs[name].get("needs", [])
    return [n] if isinstance(n, str) else list(n)

covered = set()
stack = needs("ci-success")
while stack:
    job = stack.pop()
    if job not in covered:
        covered.add(job)
        stack.extend(needs(job))

missing = sorted(set(jobs) - covered - {"ci-success", "v1-current"})
if missing:
    print(f"::error::{sys.argv[1]}: job(s) not reachable from ci-success.needs: {', '.join(missing)}")
    sys.exit(1)
print(f"ok: all {len(jobs)} jobs are waited for by ci-success (or exempt)")
PY

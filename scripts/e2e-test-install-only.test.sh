#!/usr/bin/env bash
# e2e-test's install-only mode: the test-running steps are gated off by it, the
# install steps are not, and the version step resolves from the lockfile alone.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
set -euo pipefail
cd "$(dirname "$0")/.."
python3 - <<'PY'
import os, re, subprocess, sys, tempfile, yaml

doc = yaml.safe_load(open("actions/e2e-test/action.yml"))
steps = doc["runs"]["steps"]
by_name = {s["name"]: s for s in steps}
fail = []

if doc["inputs"]["install-only"]["default"] != "false":
    fail.append("install-only must default to false so existing callers still run the tests")

gated = {n for n, s in by_name.items() if "install-only" in str(s.get("if", ""))}
if gated != {"Pre-run", "Run e2e tests"}:
    fail.append(f"install-only must gate exactly Pre-run and Run e2e tests, gates {sorted(gated)}")
for n in ("Install Playwright browsers", "Install Playwright OS dependencies"):
    s = by_name[n]
    if "install-only" in str(s.get("if", "")):
        fail.append(f"{n} must still run in install-only mode")
    if "inputs.workspace" not in str(s["env"]) or "--workspace" not in s["run"]:
        fail.append(f"{n} must honour the workspace input")
if "timeout 300" not in by_name["Install Playwright browsers"]["run"]:
    fail.append("the browser download must be bounded by a per-attempt timeout")

# The version step must resolve from the lockfile when nothing is installed.
with tempfile.TemporaryDirectory() as d:
    open(os.path.join(d, "package-lock.json"), "w").write(
        '{"packages":{"node_modules/@playwright/test":{"version":"1.2.3"}}}')
    open(os.path.join(d, "package.json"), "w").write('{"name":"x"}')
    out = os.path.join(d, "out")
    r = subprocess.run(["bash", "-c", by_name["Resolve Playwright version"]["run"]], cwd=d,
                       env={**os.environ, "PM": "npm", "GITHUB_OUTPUT": out}, capture_output=True, text=True)
    got = open(out).read().strip() if os.path.exists(out) else ""
    if got != "version=1.2.3":
        fail.append(f"lockfile fallback did not resolve the version: rc={r.returncode} out={got!r} err={r.stderr.strip()}")

for f in fail:
    print(f"::error::{f}")
sys.exit(1 if fail else 0)
PY
echo "e2e-test install-only: ok"

#!/usr/bin/env python3
"""Run a composite action's `run:` steps locally, through its real action.yml.

The degraded-mode replica (`.claude/ci-replica.json`) uses this to exercise the
same `uses: ./actions/<name>` paths self-check.yml does, so a drift between an
action's `inputs:`/`env:` wiring and its script is caught here as it would be on
a runner, not just the script called directly.

    scripts/run-composite.py actions/ci-success --input needs='{"a":{"result":"success"}}'
    scripts/run-composite.py actions/pr-body-lint --input body='Closes #1, #2' --expect fail
    scripts/run-composite.py actions/deploy-target --input git-ref=dev ... --expect-output build=true

Supported: `${{ inputs.X }}`, `${{ github.action_path }}`, `${{ github.* }}` from
GITHUB_* env vars, `${{ steps.<id>.outputs.<k> }}` in outputs, step `env:`,
`shell: bash`, and GITHUB_OUTPUT. Anything else — a nested `uses:` step, an `if:`,
another shell, an unknown expression — exits 2, so an unsupported action reads as
a harness failure, never as a pass.
"""
import argparse
import os
import re
import subprocess
import sys
import tempfile

import yaml

EXPR = re.compile(r"\$\{\{\s*([^}]*?)\s*\}\}")


class Unsupported(Exception):
    pass


def resolve(expr, inputs, action_path, step_outputs):
    if expr.startswith("inputs."):
        return inputs.get(expr[len("inputs."):], "")
    if expr == "github.action_path":
        return action_path
    if expr.startswith("github."):
        return os.environ.get("GITHUB_" + expr[len("github."):].upper(), "")
    m = re.fullmatch(r"steps\.([\w-]+)\.outputs\.([\w-]+)", expr)
    if m:
        return step_outputs.get(m.group(1), {}).get(m.group(2), "")
    raise Unsupported(f"expression not supported locally: ${{{{ {expr} }}}}")


def substitute(text, inputs, action_path, step_outputs):
    return EXPR.sub(lambda m: resolve(m.group(1), inputs, action_path, step_outputs), str(text))


def parse_outputs(path):
    """GITHUB_OUTPUT's two forms: `k=v` and the `k<<DELIM ... DELIM` heredoc."""
    out, lines, i = {}, open(path).read().splitlines(), 0
    while i < len(lines):
        line = lines[i]
        m = re.fullmatch(r"([\w-]+)<<(.+)", line)
        if m:
            body = []
            i += 1
            while i < len(lines) and lines[i] != m.group(2):
                body.append(lines[i])
                i += 1
            out[m.group(1)] = "\n".join(body)
        elif "=" in line:
            k, v = line.split("=", 1)
            out[k] = v
        i += 1
    return out


def run(action_dir, given):
    action_path = os.path.abspath(action_dir)
    with open(os.path.join(action_path, "action.yml")) as f:
        spec = yaml.safe_load(f)
    if spec.get("runs", {}).get("using") != "composite":
        raise Unsupported("not a composite action")

    inputs = {}
    for name, meta in (spec.get("inputs") or {}).items():
        default = (meta or {}).get("default", "")
        inputs[name] = substitute(default, {}, action_path, {}) if default is not None else ""
    unknown = set(given) - set(inputs)
    if unknown:
        raise Unsupported(f"inputs not declared by the action: {sorted(unknown)}")
    inputs.update(given)
    for name, meta in (spec.get("inputs") or {}).items():
        if (meta or {}).get("required") and not inputs.get(name):
            raise Unsupported(f"required input missing: {name}")

    step_outputs = {}
    for index, step in enumerate(spec["runs"].get("steps") or []):
        label = step.get("name") or step.get("id") or f"step {index}"
        if "uses" in step:
            raise Unsupported(f"{label}: a nested `uses:` step cannot run locally")
        if "if" in step:
            raise Unsupported(f"{label}: step `if:` is not evaluated locally")
        if step.get("shell") != "bash":
            raise Unsupported(f"{label}: shell {step.get('shell')!r} is not supported")

        script = substitute(step["run"], inputs, action_path, step_outputs)
        env = dict(os.environ)
        for k, v in (step.get("env") or {}).items():
            env[k] = substitute(v, inputs, action_path, step_outputs)
        with tempfile.NamedTemporaryFile("w", suffix=".sh", delete=False) as sf, \
                tempfile.NamedTemporaryFile("w", delete=False) as of:
            sf.write(script)
        env["GITHUB_OUTPUT"] = of.name
        env["GITHUB_ACTION_PATH"] = action_path
        # The runner's own invocation for `shell: bash`.
        rc = subprocess.call(["bash", "--noprofile", "--norc", "-eo", "pipefail", sf.name], env=env)
        if step.get("id"):
            step_outputs[step["id"]] = parse_outputs(of.name)
        os.unlink(sf.name)
        os.unlink(of.name)
        if rc != 0:
            return rc, {}

    outputs = {
        name: substitute((meta or {}).get("value", ""), inputs, action_path, step_outputs)
        for name, meta in (spec.get("outputs") or {}).items()
    }
    return 0, outputs


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("action_dir")
    p.add_argument("--input", action="append", default=[], metavar="NAME=VALUE")
    p.add_argument("--expect", choices=["pass", "fail"], default="pass")
    p.add_argument("--expect-output", action="append", default=[], metavar="NAME=VALUE")
    a = p.parse_args()

    given = dict(kv.split("=", 1) for kv in a.input)
    try:
        rc, outputs = run(a.action_dir, given)
    except Unsupported as err:
        print(f"run-composite: UNSUPPORTED — {err}", file=sys.stderr)
        return 2

    if a.expect == "fail":
        if rc == 0:
            print(f"run-composite: {a.action_dir} PASSED a case that must fail", file=sys.stderr)
            return 1
        print(f"run-composite: ok — {a.action_dir} failed as expected (exit {rc})")
        return 0
    if rc != 0:
        print(f"run-composite: {a.action_dir} failed (exit {rc})", file=sys.stderr)
        return rc
    for kv in a.expect_output:
        name, want = kv.split("=", 1)
        if outputs.get(name) != want:
            print(f"run-composite: output {name}={outputs.get(name)!r}, expected {want!r}", file=sys.stderr)
            return 1
    print(f"run-composite: ok — {a.action_dir} passed" + (f" {outputs}" if outputs else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())

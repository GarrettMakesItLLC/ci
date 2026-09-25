#!/usr/bin/env bash
# Every actions/*/action.yml parses as a composite action and declares what the runner needs.
# Run by self-check.yml and by the degraded-mode replica (.claude/ci-replica.json).
fail=0
shopt -s nullglob
found=0
for f in actions/*/action.yml; do
  found=$((found + 1))
  for key in name description runs; do
    grep -qE "^${key}:" "$f" || { echo "::error file=$f::missing top-level '${key}:'"; fail=1; }
  done
  grep -qE "^  using: composite" "$f" || { echo "::error file=$f::runs.using must be 'composite'"; fail=1; }
  # Every step in a composite action must declare a shell, and the
  # runner's error for a missing one names no file.
  awk -v f="$f" '
    /^    - / { instep=1; hasrun=0; hasshell=0; hasuses=0 }
    /^      run:/   { hasrun=1 }
    /^      shell:/ { hasshell=1 }
    /^      uses:/  { hasuses=1 }
    /^    - |^$/ {
      if (instep && hasrun && !hasshell && !hasuses) {
        printf "::error file=%s::a run: step is missing shell:\n", f; exit 1
      }
    }
  ' "$f" || fail=1
done
[ "$found" -eq 0 ] && { echo "::error::no composite actions found — did the layout change?"; fail=1; }
echo "checked $found composite action(s)"
exit "$fail"

# CLAUDE.md

**Autonomy: autonomous-merge**, same discipline as every other repo — reviewed, CI green, merge it.
CI here is `actionlint` plus a real consumer's workflow run, so treat both as the gate: never merge
on red or pending checks. Because a change here lands in every consumer at once with no PR to catch
it there, hold the bar higher before calling something reviewed — see below.

Shared GitHub Actions for every `GarrettMakesItLLC` repo. `README.md` is the consumer-facing
contract — read it before changing anything here, because it is what other repos were written
against.

## The thing that makes this repo dangerous

**A change here lands in every consumer at once, with no PR in those repos to catch it.** There is no
staging tier for a shared action. That asymmetry drives every rule below.

- Consumers pin `@v1`. Never tell one to use `@main`.
- A backward-compatible change moves the `v1` tag. A breaking change cuts `v2` and consumers migrate
  deliberately — never repoint `v1` at incompatible behaviour.
- Adding a required input is breaking. Adding an optional input with a default is not.
- **Prefer a composite action over a reusable workflow for anything a ruleset requires.** A job
  calling a reusable workflow emits a check named `<caller-job> / <callee-job>`, which cannot match the
  bare `CI Success` and `Semantic PR Title` contexts the rulesets require. A composite action runs
  inside a job the caller names, leaving the check name where it belongs. `issue-status-clear` stays a
  reusable workflow because it fires on an `issues` event and gates nothing.

## Layout

```text
actions/<name>/action.yml               composite actions (step-level)
.github/workflows/<name>.yml            reusable workflows (job-level, workflow_call)
```

A composite action runs inside a caller's job and shares its checkout. A reusable workflow is its own
job with its own runner. Pick the composite unless the thing genuinely needs to be a separate job —
each job bills a whole minute rounded up.

## Verifying a change

There is no test suite; the consumers are the tests. Before moving `v1`:

```bash
actionlint                              # not installed on this machine — CI runs it
```

Validate against a real consumer by pointing one repo's workflow at the commit SHA in a PR, letting
its CI run, then moving the tag once it is green. A tag moved on an unproven commit breaks four repos
simultaneously.

## Scope

Only what is byte-identical across consumers belongs here. The job graph does not — it varies with
each repo's stack and lanes, and a workflow abstract enough to cover all of them would be configured
rather than shared. `README.md` records that boundary and why.

CI *conventions* — concurrency, trigger matrices, timeouts, caching, capability gates — are not code.
They live in `~/dotclaude/rules/ci.md` and load whenever a workflow file is open. Do not restate them
here.

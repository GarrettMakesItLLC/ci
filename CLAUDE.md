# CLAUDE.md

**Autonomy: autonomous-merge.** Merge to `main` on green CI; CI is the gate. Consumers pin `@v1`, and
`release.yml` moves that tag automatically once the merged commit's self-check is green — merging is
what releases (see README and the blast-radius note below).

Shared GitHub Actions for every `GarrettMakesItLLC` repo. `README.md` is the consumer-facing
contract — read it before changing anything here, because it is what other repos were written
against.

## The thing that makes this repo dangerous

**A change here lands in every consumer at once, with no PR in those repos to catch it.** There is no
staging tier for a shared action. That asymmetry drives every rule below.

- Consumers pin `@v1`. Never tell one to use `@main`.
- A backward-compatible change moves the `v1` tag. A breaking change cuts `v2` and consumers migrate
  deliberately — never repoint `v1` at incompatible behaviour.
- **`v1` moves on merge, not by hand.** `release.yml` waits for the self-check on the merged commit
  and then repoints the tag; a change meant for `v2` opts out with `[no-release]` in its merge
  commit. The `v1 covers main` job in `self-check.yml` fails whenever the tag is behind
  `.github/workflows/` or `actions/`, so an unreleased fix is red rather than invisible. It has been
  invisible before: the fix for MuscleBuddy#3946/#3947 sat untagged while two closed issues said it
  had shipped and the consumer went on running the pre-fix revision (MuscleBuddy#5764).
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
~/dotclaude/bin/ci-replica.sh           # self-check's jobs, locally, per .claude/ci-replica.json
```

Validate against the canary consumer, NetWorthy (README § Releasing), by pointing its workflow at
the commit SHA in a PR and letting its CI run. A tag moved on an unproven commit breaks four repos simultaneously, so that
validation belongs **before the merge** — merging is what releases now, and there is no gap
afterwards in which to have second thoughts.

### When Actions is down

`.claude/fleet-mode.json` says whether the repo is in degraded mode, and #82 is its coordination
issue. A merge is then authorized by `ALL GREEN @ <sha>` from the replica on that SHA, not by CI.
The replica runs self-check's fixture jobs through each composite action's real `action.yml` with
`scripts/run-composite.py`. It cannot run a reusable workflow, so the post-deploy-probe fixtures are
NOT-RUN.

**A window merge carries `[no-release]` in its merge commit.** No consumer CI can validate it before
the merge, so it must not move `v1` on the first push after Actions returns. It ships when the
`v1-release` item in `.claude/owed-verdicts.json` is paid: a consumer runs the SHA, then Release runs
by hand. Pay that item before merging anything else once Actions is back, because the next ordinary
merge moves `v1` over every window change at once.

## Scope

Only what is byte-identical across consumers belongs here. The job graph does not — it varies with
each repo's stack and lanes, and a workflow abstract enough to cover all of them would be configured
rather than shared. `README.md` records that boundary and why.

CI *conventions* — concurrency, trigger matrices, timeouts, caching, capability gates — are not code.
They live in `~/dotclaude/rules/ci.md` and load whenever a workflow file is open. Do not restate them
here.

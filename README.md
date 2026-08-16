# ci

Shared GitHub Actions for every `GarrettMakesItLLC` repo: the parts of CI that are genuinely
identical across them.

## What is here

| Path | Kind | Use |
| --- | --- | --- |
| `actions/setup-node-workspace` | composite | Node + workspace-aware dependency cache, install gated on a cache miss. npm and pnpm. Extra cache paths and a pre-install hook are configurable. |
| `actions/ci-success` | composite | The one aggregate required status check. Fails when a required job was **skipped**. |
| `actions/pr-title-lint` | composite | Conventional-Commit check on the PR title. |
| `actions/file-failure-issue` | composite | File an issue for an unwatched automation failure, reusing an open match instead of duplicating. |
| `actions/accessibility-check` | composite | `pa11y-ci` against a URL the caller is already serving. Tier 2. |
| `actions/build` | composite | Run the repo's build script; optional workspace filter. |
| `actions/e2e-test` | composite | Playwright browser install (lockfile-keyed cache) + e2e script. Tier 2. |
| `actions/format-check` | composite | Formatter (Prettier or Biome) in check mode; fails on drift. |
| `actions/lint-check` | composite | Repo linter (ESLint by default) in error-on-warning mode. |
| `actions/security-scan` | composite | Dependency audit + CodeQL SAST, either half switchable off. |
| `actions/unit-test` | composite | Unit tests with coverage; optional minimum line-coverage gate. |
| `.github/workflows/issue-status-clear.yml` | reusable | Strip `status:*` labels when an issue closes. |
| `.github/workflows/release-cut.yml` | reusable | Cut a release branch from `dev` and open its promotion PR. |
| `.github/workflows/scheduled-ops.yml` | reusable | Cron-triggered dependency bump PR + stale issue/PR sweep. |

## Why almost everything here is a composite action

A job that calls a **reusable workflow** produces a check named
`<caller-job> / <callee-job>`, not a bare name. The branch rulesets in every repo require the exact
contexts **`CI Success`** and **`Semantic PR Title`**, so a reusable workflow can never satisfy them —
and pointing a ruleset at the compound name would couple it to the caller's job id, which is the
opposite of portable.

A composite action runs inside a job the caller declares and names, so the check name stays the
caller's to control. `issue-status-clear` and `release-cut` are reusable workflows anyway, because
neither gates a PR — one is triggered by an `issues` event, the other by `workflow_dispatch` — so
nothing requires either's check name to stay stable.

## Consuming it

**Pin a tag, never `@main`.** A push to `main` here would change CI in every repo at once, with no
PR in those repos to catch it.

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: GarrettMakesItLLC/ci/actions/setup-node-workspace@v1
        with:
          package-manager: npm
      - run: npm run lint

  # The job name IS the required-status-check context. Do not rename it.
  ci-success:
    name: CI Success
    # `always()` so it still runs when a dependency failed — that is the case it
    # reports on.
    if: always() && github.event_name == 'pull_request'
    needs: [lint]
    runs-on: ubuntu-latest
    steps:
      - uses: GarrettMakesItLLC/ci/actions/ci-success@v1
        with:
          needs: ${{ toJSON(needs) }}
```

The caller passes its own `needs` context because an action cannot read the caller's job graph.
`ci-success` then reports on exactly what that repo declared, so this repo never needs to know any
consumer's job names.

### `setup-node-workspace` extras

`pre-install-run` interposes a step between `setup-node` and the install — for anything that has
to run after Node is installed but before the lockfile is read, such as pinning npm via Corepack:

```yaml
- uses: GarrettMakesItLLC/ci/actions/setup-node-workspace@v1
  with:
    node-version: '24'
    package-manager: npm
    pre-install-run: corepack enable npm
```

`cache-path-extra` appends to the cached path list, for a generated artefact that lives outside
`node_modules` (a Prisma client emitted to `prisma/generated/`, say) and should expire with the
same dependency cache:

```yaml
- uses: GarrettMakesItLLC/ci/actions/setup-node-workspace@v1
  with:
    cache-path-extra: prisma/generated
    cache-key-extra: ${{ hashFiles('prisma/schema.prisma') }}
```

Both are optional and empty by default — existing callers are unaffected.

### Consuming a reusable workflow

`release-cut.yml` and `issue-status-clear.yml` are `workflow_call` workflows, not composite actions —
a consumer needs its own thin trigger file that calls them:

```yaml
# .github/workflows/release-cut.yml
name: Cut a release branch

on:
  workflow_dispatch:
    inputs:
      sha:
        description: 'dev commit to cut from (default: dev HEAD)'
        required: false
        type: string

jobs:
  cut:
    permissions:
      contents: write
      pull-requests: read
      issues: write
    uses: GarrettMakesItLLC/ci/.github/workflows/release-cut.yml@v1
    with:
      sha: ${{ inputs.sha }}
    secrets: inherit
```

`secrets: inherit` passes the caller's own secrets (`RELEASE_PAT`, `GITHUB_TOKEN`) through — the
reusable workflow never needs them named individually in the consumer.

**A promotion PR carrying no checks at all is the failure this workflow guards hardest against**,
because it reads as a green light rather than a red one. Two things produce it: a PR opened with
`GITHUB_TOKEN` (hence `RELEASE_PAT`), and a PR that conflicts with `main` — GitHub builds no
`refs/pull/N/merge` ref for one, so `pull_request` workflows have nothing to check out and never
start. So the cut refuses to run when this cycle's promotion PR was closed without merging, which is
what lets `main` drift far enough to conflict, and fails after opening the PR if that PR already
conflicts. Pass `allow-unmerged-promotions: true` to cut anyway, accepting that the abandoned
promotion's commits never shipped.

**The `permissions:` block on the calling job is not optional in practice, for either reusable
workflow here.** A called workflow's own `permissions:` block can only narrow what the run was
granted, never widen it — so if a repo's default `GITHUB_TOKEN` permission is `read` (common), a
caller that omits `permissions:` mints a read-only token for the run, and `release-cut.yml`'s
`contents: write` / `issues: write`, or `issue-status-clear.yml`'s `issues: write`, then exceed it.
That fails the whole run at `startup_failure` with **zero jobs and no logs**, before any job output
exists to explain why — this is the single most common way to misconfigure a consumer of either
workflow. The caller must grant the permission explicitly on the job that calls it:

```yaml
# .github/workflows/issue-status-clear.yml
name: Clear status label on issue close

on:
  issues:
    types: [closed]

jobs:
  clear-status:
    permissions:
      issues: write
    uses: GarrettMakesItLLC/ci/.github/workflows/issue-status-clear.yml@v1
```

### Repos running a merge queue: one check, both events

`actions/ci-success` has no event gating of its own — it only reads `inputs.needs`. A repo running a
GitHub Enterprise merge queue does **not** add a second job or a second required check. It widens the
same `ci-success` job's `if:` to also run on `merge_group`, and widens `needs:` to cover both tiers of
jobs:

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps: [...] # Tier 1: fast, path-filtered — lint/typecheck/unit. pull_request only.

  e2e:
    # Tier 2 only: `merge_group` is a ref-update trigger, not a PR event — a job
    # triggered by it does not see github.event.pull_request. Anything reading PR
    # context has to move or be adjusted when it moves into this job.
    if: github.event_name == 'merge_group'
    runs-on: ubuntu-latest
    steps: [...] # e2e / a11y / any suite too slow for the PR lane.

  # The one required check, on both events. Do not split this into a second job —
  # a branch ruleset requires exactly one context (`CI Success`), and GitHub's
  # merge queue re-validates every required context against the merge group's
  # synthetic commit, so the same check name has to post on both events or the
  # queue entry hangs waiting for a context that never arrives.
  ci-success:
    name: CI Success
    if: always() && (github.event_name == 'pull_request' || github.event_name == 'merge_group')
    needs: [lint, e2e]
    runs-on: ubuntu-latest
    steps:
      - uses: GarrettMakesItLLC/ci/actions/ci-success@v1
        with:
          needs: ${{ toJSON(needs) }}
```

`ci-success`'s own "did anything skip that shouldn't have" check is naturally event-aware without any
extra input: on `pull_request`, `e2e` is *expected* to have skipped (it only runs on `merge_group`) —
pass it via `allow-skipped: e2e` (or list every Tier-2-only job id, comma-separated) so the composite
doesn't fail the PR lane over a job that correctly didn't run. On `merge_group`, `lint` has already
run to completion on the same commits during the PR lane and is *expected* to skip again in the
queue if the consumer path-filters it to `pull_request` only — add it to `allow-skipped` too if that's
how the job is written; if `lint` is unconditional (no `if:`), it re-runs on `merge_group` and
reports `success`, needing no allowance. Either way, never drop a job from `needs:` just to dodge this
— that reintroduces the "green over nothing" gap `allow-skipped` exists to name explicitly instead of
silently.

### Consuming from a private repo

This repo is public, so any consumer can call its actions and reusable workflows with no extra
setup. A **private** consumer still works the same way — a private repo can call a public repo's
actions by default. The access grant (*Settings → Actions → General → Access → Accessible from
repositories in the organization*) is only needed the other direction: if this repo, or another
action it calls, were ever private. Without it in that case, every `uses:` resolves to a 404 that
reads like a typo.

## What deliberately stays per repo

The job graph. What varies most between these repos is exactly what CI *does* — one product repo has
Android, e2e, a11y and Prisma migration lanes; another has none of them yet; a third is pnpm on
Next. A workflow abstract enough to cover all of that would be configured, not shared.

So each repo keeps its own `ci.yml` and composes these pieces. What lives here is only what is
byte-identical wherever it appears.

Conventions — concurrency groups, trigger matrices, `timeout-minutes`, caching rules, capability
gates — are not code and are not here. They live in `~/dotclaude/rules/ci.md`, which loads whenever a
workflow file is open.

## Releasing

`v1` is a moving major tag. A backward-compatible change moves it; a breaking one cuts `v2` and
consumers migrate deliberately.

```bash
git tag -f v1 && git push -f origin v1
```

Force-moving a tag is the standard Actions convention and the reason pinning `@main` is wrong: a
consumer opts into `v1`'s compatibility promise, not into this repo's tip.

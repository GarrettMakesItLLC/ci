# ci

Shared GitHub Actions for every `GarrettMakesItLLC` repo: the parts of CI that are genuinely
identical across them.

## What is here

| Path | Kind | Use |
| --- | --- | --- |
| `actions/setup-node-workspace` | composite | Node + workspace-aware dependency cache, install gated on a cache miss. npm and pnpm. |
| `actions/ci-success` | composite | The one aggregate required status check. Fails when a required job was **skipped**. |
| `actions/pr-title-lint` | composite | Conventional-Commit check on the PR title. |
| `actions/file-failure-issue` | composite | File an issue for an unwatched automation failure, reusing an open match instead of duplicating. |
| `.github/workflows/issue-status-clear.yml` | reusable | Strip `status:*` labels when an issue closes. |

## Why almost everything here is a composite action

A job that calls a **reusable workflow** produces a check named
`<caller-job> / <callee-job>`, not a bare name. The branch rulesets in every repo require the exact
contexts **`CI Success`** and **`Semantic PR Title`**, so a reusable workflow can never satisfy them —
and pointing a ruleset at the compound name would couple it to the caller's job id, which is the
opposite of portable.

A composite action runs inside a job the caller declares and names, so the check name stays the
caller's to control. `issue-status-clear` is the one reusable workflow left, because it is triggered by
an `issues` event rather than gating a PR — nothing requires its name.

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
    # reports on. Restricted to pull_request because it is the PR gate.
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

### Private-repo access

Every repo here is private, and a private repo's actions are **not** callable from another repo by
default. Each consumer needs Actions access granted: *Settings → Actions → General → Access →
Accessible from repositories in the organization*. Without it every `uses:` resolves to a 404 that
reads like a typo.

## What deliberately stays per repo

The job graph. What varies most between these repos is exactly what CI *does* — MuscleBuddy has
Android, e2e, a11y and Prisma migration lanes; NetWorthy has none of them yet; AdventureOS is pnpm on
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

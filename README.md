# ci

Shared GitHub Actions for every `GarrettMakesItLLC` repo: the parts of CI that are genuinely
identical across them.

## What is here

| Path | Kind | Use |
| --- | --- | --- |
| `actions/setup-node-workspace` | composite | Node + workspace-aware dependency cache, install gated on a cache miss. npm and pnpm. Extra cache paths and a pre-install hook are configurable. |
| `actions/ci-success` | composite | The one aggregate required status check. Fails when a required job was **skipped**. |
| `actions/pr-title-lint` | composite | Conventional-Commit check on the PR title. |
| `actions/pr-body-lint` | composite | Catch two silent GitHub closing-keyword traps in the PR body: a negated keyword (including contractions, `no`, `without`) and an unrepeated list (`#A, #B`, `#A and #B`, `#A & #B`). Quoted syntax in code is ignored. `lint.mjs` exports `lintPrBody`. |
| `actions/file-failure-issue` | composite | File an issue for an unwatched automation failure, reusing an open match instead of duplicating (`mode: file`, the default), or close that issue once the failure stops recurring (`mode: close`, which also takes `additional-titles` and `title-prefix` and closes every match). |
| `actions/check-migration-locks` | composite | Fail a Prisma migration that takes a heavy lock on an existing table without `SET LOCAL lock_timeout`, or runs `CREATE INDEX CONCURRENTLY` beside another statement. `since` grandfathers applied migrations. |
| `actions/check-action-pins` | composite | Fail on an unpinned or drifting `uses:` — third-party actions off a SHA, org actions on `@main`, or the same action split across majors. |
| `actions/build` | composite | Run the repo's build script; optional workspace filter. |
| `actions/deploy-target` | composite | Decide whether a push deploys — branch match plus an optional path match — in one place. The copy a Vercel `ignoreCommand` vendors is kept honest by `check-vendored-copy`. |
| `actions/check-vendored-copy` | composite | Fail when a file vendored from this repo (`deploy-target.mjs`, `pr-body-lint/lint.mjs`) no longer matches the upstream file at a pinned immutable ref. Comments and formatting are ignored; logic is not. |
| `actions/check-dependency-licenses` | composite | Fail-closed production licence gate: an allowlist judged through an SPDX parser over `package-lock.json`. Unknown ids, `SEE LICENSE IN ...`, Commons-Clause, BUSL, UNLICENSED and a missing licence all fail. Needs no install. |
| `actions/check-migration-order` | composite | Fail a PR that adds a Prisma migration which sorts before or collides with the newest on base, is future-dated, sits on a round hour or shares a timestamp, or that edits, renames or deletes an applied one. |
| `actions/check-required-checks` | composite | Required-checks drift guard: every name in `.github/required-checks.json` is emitted by exactly one job, and a promotion branch's gating name is reachable only from the promotion PR. |
| `actions/e2e-test` | composite | Playwright browser install (lockfile-keyed cache, bounded and retried) + e2e script. Tier 2. `install-only: 'true'` stops after the install. |
| `actions/format-check` | composite | Formatter (Prettier or Biome) in check mode; fails on drift. |
| `actions/lint-check` | composite | Repo linter (ESLint by default) via its package script. Fails on the script's exit code, so warning policy lives in the script (`eslint --max-warnings 0`). |
| `actions/security-scan` | composite | Dependency audit + CodeQL SAST, either half switchable off. **The CodeQL half needs `security-events: write` on the calling job** — see below. |
| `actions/unit-test` | composite | Unit tests with coverage. The coverage gate is off by default (`min-coverage: '0'`); set it to enforce a minimum line-coverage percentage. |
| `actions/check-dependency-inventory` | composite | Doc-vs-manifest drift check: fails when a direct dependency has no row in a repo's dependency-inventory doc. Manifests scanned, fields checked, workspace-internal prefixes, an allowlist and the doc-match mode are all inputs. An unparseable manifest, or a scan that finds no dependencies (unless `allow-empty: 'true'`), fails. |
| `actions/cwv-measure` | composite | Pinned local Lighthouse over a route list at a base URL; writes one night's LCP / TBT / CLS record (median of N runs per route). Measures, never judges. |
| `actions/cwv-judge` | composite | Fail only on a Core Web Vitals regression that **holds across nights** — over the floor and over a rise factor against the rolling median for N consecutive nights. Too little history passes open and says `insufficient-history`. |
| `.github/workflows/issue-status-clear.yml` | reusable | Strip `status:*` labels when an issue closes. |
| `.github/workflows/release-cut.yml` | reusable | Cut a release branch from `dev` and open its promotion PR. |
| `.github/workflows/scheduled-ops.yml` | reusable | Cron-triggered dependency bump PR + stale issue/PR sweep. |
| `.github/workflows/post-deploy-probe.yml` | reusable | Probe a URL set, assert status/headers/body, file an issue on failure. |
| `.github/workflows/nightly-cwv.yml` | reusable | Nightly LCP / TBT / CLS over a product's prerendered routes (build, serve, `cwv-measure`, `cwv-judge`, rolling history, failure issue). |

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

`v1` tracks `main`: merging is what releases, and the `Release` workflow repoints the tag once the
self-check on the merged commit is green, and cuts an immutable `v1.N.M` for the canary (see
**Releasing**). A change meant for a future major says `[no-release]` in
its merge commit and leaves `v1` alone.

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

### `file-failure-issue`'s `close` mode

`mode: close` is the other half of `mode: file` — same dedupe key, opposite direction. A synthetic
monitor that reruns the same check on a schedule files on failure and closes on the next success,
so the tracker never shows a stale "this is broken" once it isn't:

```yaml
- name: File an alert issue
  if: steps.check.outcome == 'failure'
  uses: GarrettMakesItLLC/ci/actions/file-failure-issue@v1
  with:
    title: 'URGENT: the scheduled check did not pass'
    body-file: alert.md
    labels: ci-failure,type:bug,status:ready
    token: ${{ github.token }}

- name: Close the alert issue once green again
  if: steps.check.outcome == 'success'
  uses: GarrettMakesItLLC/ci/actions/file-failure-issue@v1
  with:
    mode: close
    title: 'URGENT: the scheduled check did not pass'
    dedupe-label: ci-failure
    token: ${{ github.token }}
```

A lane whose symptoms are filed under several titles closes them all in one call, and a title that embeds
a varying suffix closes by prefix. Every open issue under the dedupe label that matches the marker, the
`title`, an `additional-titles` entry or the `title-prefix` is closed (`numbers` lists them):

```yaml
- uses: GarrettMakesItLLC/ci/actions/file-failure-issue@v1
  with:
    mode: close
    title: 'Nightly lane has gone quiet'
    additional-titles: |
      Nightly lane has gone quiet - refused before step 1
    title-prefix: 'Nightly lane failed: '
    dedupe-label: ci-failure
    token: ${{ github.token }}
```

`title` and the dedupe label (`dedupe-label`, or the first entry of `labels`) must match exactly
between the two calls — that pair is the only thing tying a close back to the issue a prior run
filed. `close` no-ops silently when nothing is open under that title, which is the common case: most
runs are green and never filed anything.

### `e2e-test` install-only

A job that starts its own server and runs its own scripts between the install and the test should not
hand-write the install sequence. `install-only` does the resolve, cache, bounded and retried browser
download and apt-cached OS dependencies, then stops:

```yaml
- uses: GarrettMakesItLLC/ci/actions/e2e-test@v1
  with:
    install-only: 'true'
    browsers: chromium
    # workspace: '@org/web'   # when @playwright/test lives in a workspace
- run: npm run test:a11y
```

The version comes from `npm list`, falling back to `package-lock.json` when nothing is installed yet.

### `check-dependency-licenses`

```yaml
- uses: GarrettMakesItLLC/ci/actions/check-dependency-licenses@v1
  with:
    exceptions-file: scripts/license-exceptions.json   # optional
    allow-extra: MPL-2.0                               # optional, a licence you have reviewed
    workspaces: apps/web                               # optional, judge one workspace's closure
    min-packages: '100'                                # a scan of nothing passes everything
```

An exception is `{ "name": "pkg" | "prefix*", "license": "<exact recorded licence, or (none)>", "reason": "..." }`.
It stops applying when the package's licence changes. Run it after checkout; no install is needed.

### `check-migration-order`

```yaml
- uses: actions/checkout@v7
  with: { fetch-depth: 0 }
- uses: GarrettMakesItLLC/ci/actions/check-migration-order@v1
  with:
    allow-round-hour: |
      20260811030000_add_pet_clients
```

The base comes from `GITHUB_BASE_REF` (or `base-ref`) and is fetched when missing. On a promotion into
`main`, `trunk-ref` (default `origin/dev`) names the migrations the branch inherits; they were judged when
they merged there. `allow-collisions` baselines an exact set of already-applied duplicate directories.

### `check-required-checks`

```yaml
- uses: GarrettMakesItLLC/ci/actions/check-required-checks@v1
  with:
    promotion-branches: main   # empty for a single-tier repo
```

The manifest holds the names each protected branch's ruleset requires, written once and edited together with the ruleset:

```json
{ "main": ["Promotion gate"], "dev": [], "inherited": { "main": ["CI Success"], "dev": ["CI Success"] }, "integration_id": 15368 }
```

### `check-vendored-copy`

```yaml
- uses: GarrettMakesItLLC/ci/actions/check-vendored-copy@v1
  with:
    vendored-path: scripts/ci/deploy-target.mjs
    upstream-path: actions/deploy-target/deploy-target.mjs
    ref: v1.4.0          # the immutable tag the copy was taken from
    latest-ref: v1       # optional: warn when the copy is behind
```

### `check-dependency-inventory` examples

A monorepo with a markdown table (each dependency is the first column's `` `name` `` code span),
scanning every package's manifest and treating its own scope as internal:

```yaml
- uses: GarrettMakesItLLC/ci/actions/check-dependency-inventory@v1
  with:
    doc-path: docs/dependencies.md
    manifest-paths: packages/*/package.json
    workspace-prefixes: '@gmi/,@garrettmakesitllc/'
```

A repo whose doc is prose rather than a strict table, scanning the root manifest plus two app
manifests, with an allowlist for dependencies that have no external surface of their own:

```yaml
- uses: GarrettMakesItLLC/ci/actions/check-dependency-inventory@v1
  with:
    doc-path: docs/architecture/dependencies.md
    manifest-paths: package.json,apps/server/package.json,apps/web/package.json,packages/*/package.json
    dependency-fields: dependencies
    workspace-prefixes: '@adventureos/'
    allowlist: 'react,react-dom,zod'
    match-mode: substring
```

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

**A composite action needs the caller's permissions too, and `security-scan` is the one that
bites.** A composite action cannot declare `permissions:` at all — it runs inside the caller's job
and inherits that job's token. `github/codeql-action/analyze` must upload its results, which
requires `security-events: write`, and a repo on the common read-only default `GITHUB_TOKEN` gets a
failure with nothing in the consuming example to have anticipated it (#54d). Unlike the reusable
workflows below this does not fail at `startup_failure` — the job starts, runs the whole analysis,
and fails at the upload, so the cost is the full CodeQL run as well as the red check.

```yaml
jobs:
  security:
    permissions:
      contents: read
      # CodeQL uploads its results; without this the analysis runs and then
      # fails at the upload step.
      security-events: write
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      - uses: GarrettMakesItLLC/ci/actions/security-scan@v1
```

Set `run-codeql: 'false'` if a repo wants only the dependency audit; then no extra permission is needed.

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

### `post-deploy-probe.yml`: shared availability/header/body monitor

Probes a URL set on a schedule or after a deploy, asserts status/header/body conditions per URL, and
files (or reuses, or closes on recovery) an issue via `file-failure-issue`. It replaces the shape five
products hand-wrote separately — it does not replace product-specific monitors that parse actual
response content (a robots.txt policy, a Turnstile challenge, a SHA-served-commit check).

```yaml
# .github/workflows/post-deploy-probe.yml
name: Post-deploy probe

on:
  push:
    branches: [main]
  schedule:
    - cron: '*/15 * * * *'
  workflow_dispatch:

jobs:
  probe:
    permissions:
      contents: read
      issues: write
    uses: GarrettMakesItLLC/ci/.github/workflows/post-deploy-probe.yml@v1
    with:
      probes: |
        [
          {"url": "https://example.com/health", "expected_status": 200},
          {
            "url": "https://example.com/",
            "expected_status": 200,
            "body_not_contains": "Authentication Required",
            "expect_headers_present": ["strict-transport-security"],
            "expect_headers_contain": {"content-security-policy": "script-src"}
          }
        ]
      issue-title: Production availability probe failed
    secrets:
      token: ${{ secrets.GITHUB_TOKEN }}
```

Each `probes` entry: `url` (required), `method` (default `GET`), `expected_status` (default `200`),
`headers` (request headers to send), `expect_headers_present` (response header names that must
appear), `expect_headers_contain` (response header name -> substring its value must contain),
`body_contains` / `body_not_contains` (a substring the response body must, or must not, contain — the
latter is how NetWorthy's SSO-wall detection maps onto this). A failing entry retries
`retries` times (default 3), `retry-delay-seconds` apart (default 10), to ride out a deploy's rollout
window before counting as failed.

Set `dry-run: true` to compute pass/fail without filing or closing a real issue — used by this repo's
own `self-check.yml` to prove the failure path fires on a known-bad fixture without spamming an issue
against `GarrettMakesItLLC/ci` on every PR. That fixture also sets `fail-run: false` (default `true`),
which keeps the job green when a probe fails and leaves the verdict in the `result` output
(`success` / `failure`), so the self-check run itself is not red by design.

### `nightly-cwv.yml`: nightly Core Web Vitals, failing only on a persistent regression

```yaml
on:
  schedule:
    - cron: '17 3 * * *'
  workflow_dispatch:

jobs:
  cwv:
    uses: GarrettMakesItLLC/ci/.github/workflows/nightly-cwv.yml@v1
    with:
      build-command: npm run build --workspace=apps/web
      serve-command: npm run preview --workspace=apps/web -- --port 4173 --strictPort
      routes: |
        /
        /pricing
        /blog
    secrets: inherit
```

Build the app **with prerender**: a preview that answers a marketing route with the client-rendered
shell measures a page production never serves. `serve-command` must bind `base-url` strictly (no
fallback port), or the sweep measures whatever else answers there. Leave `serve-command` empty and
set `base-url` to measure a preview deployment instead.

**Why a night does not gate.** A lab run on a shared runner is noisy: the same unchanged build lands
on both sides of a threshold on different nights, TBT worst of all. That noise does not hold; a
regression does. So `cwv-judge` fails a route/metric only when tonight and the `sustain-nights - 1`
nights before it were each **over the floor and over `rise` × the median of the `baseline-nights`
before that night**. Both halves matter: without the ratio the gate is a coin flip at the floor,
without the floor a 15 ms → 40 ms TBT "regression" fails a route nobody calls slow. A loud single
night is reported (table, `::warning`, step summary), never failed.

| Input | Default | Meaning |
| --- | --- | --- |
| `baseline-nights` / `sustain-nights` | `7` / `3` | Median window, and consecutive elevated nights before failing. |
| `lcp-floor-ms` / `lcp-rise` | `2500` / `1.1` | LCP is the steadiest metric, so its factor is the tightest. |
| `tbt-floor-ms` / `tbt-rise` | `200` / `1.5` | TBT is summed from the runner's own main-thread tasks, so it is the noisiest. |
| `cls-floor` / `cls-rise` | `0.1` / `1.5` | |
| `runs` | `5` | Lighthouse runs per route; the median is kept. |

The defaults come from the MuscleBuddy lane's recorded history; tune them against your own routes'
nights, not by guessing.

**State across nights** is one workflow artifact (`history-artifact`, default `cwv-history`) holding
the last 30 night records, scoped to the ref that ran. Each night downloads it, judges against it,
appends tonight (green or red — a ledger of only the good nights proves nothing was slow) and
re-uploads it, which also refreshes its retention (`history-retention-days`, default 30). Give each
route set its own `history-artifact` name. The judge needs `actions: read`, which the workflow
declares. A lane that skips longer than the retention restarts cold.

**Not enough history fails open, loudly.** The gate reads `baseline-nights + sustain-nights - 1`
prior nights (9 by default) for each route; with fewer, the verdict is `insufficient-history` — a
`::warning`, a table row per metric, and a pass. A gate that read nothing must not look like a gate
that read a week and found nothing. It detects a step change, not an absolute level: a regression
already filling the baseline goes quiet, while the per-night table keeps reporting the level.

**A rig failure is not a finding.** A build, server or Lighthouse that dies before any route is
measured gives verdict `unjudged` and a failed lane whose issue says no verdict was produced. A route
that cannot be measured is listed UNMEASURED and does not stop the others.

**Lab numbers, not field numbers.** This measures a GitHub runner under simulated throttling. It buys
the trend and regression detection against a fixed rig, not figures comparable to PageSpeed
Insights or real users. INP is not measured (a lab run has nobody interacting; TBT is its proxy).
Lighthouse models HTTP/1.1's six-connection cap, so a server speaking HTTP/1.1 (such as `vite
preview`) over-charges a page with many modulepreloaded chunks relative to production's HTTP/2. The
trend is still valid against itself; for absolute fidelity measure an HTTP/2 URL.

On failure the lane files (or updates) one issue titled `issue-title` and closes it with a comment on
the next `clean` night, through `file-failure-issue`.

A caller whose lane already builds and serves the app can use the pieces directly:
`cwv-measure` (`base-url`, `routes`) → `cwv-judge` (`measurements-file`, `history-artifact`), then
upload the directory in `cwv-judge`'s `history-dir` output as the history artifact with
`overwrite: true`.

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
consumers migrate deliberately. Force-moving a tag is the standard Actions convention and the reason
pinning `@main` is wrong: a consumer opts into `v1`'s compatibility promise, not into this repo's tip.

Every release also gets an **immutable** `v1.N.M` (`scripts/next-release-tag.sh`: a `feat` since the
last one bumps the minor, anything else the patch). The repo's `Immutable release tags` tag ruleset refuses
any update or deletion of `v1.*.*`, so a pinned version means the same code forever.

### The canary: NetWorthy

NetWorthy consumes more of this repo than any other product — `setup-node-workspace`, `e2e-test`,
`pr-title-lint`, `ci-success`, `post-deploy-probe`, `release-cut` and `issue-status-clear` — so it is
the one that finds a bad release first, and it has no traffic that a red check would cost.

1. **Before merging** a change to `actions/` or `.github/workflows/`, open a NetWorthy PR pinning the
   candidate commit SHA and let its CI run. Green there is what authorizes the merge here.
2. Merging moves `v1` for every other consumer and cuts the next `v1.N.M`.
3. NetWorthy then pins that `v1.N.M` — never `@v1` — so between releases it runs an exact version.

The other products pin `@v1`.

# Contributing

Shared composite GitHub Actions and reusable workflows. Public so others can
use or adapt them; maintained solo, in spare time, with no SLA on issues or
PRs.

## Reporting a bug

Open an issue with the action/workflow name, the run that failed, and what
you expected instead.

## Pull requests

- Fork and branch from `main`.
- Keep the change scoped to one action/workflow.
- Every composite action needs `name`, `description`, and a `runs.using:
  composite` block — see `self-check.yml`, which lints for this.
- Pin dependencies to a tag, never `@main`, in any example you add to the
  README.
- CI must pass. Merges require the maintainer's approval.

This repo has the widest blast radius of anything here — a bad change lands
in every consumer at once — so review here is stricter than in a typical
app repo.

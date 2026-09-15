#!/usr/bin/env node
/**
 * Does this push deploy? Branch match plus an optional path match, decided in
 * one place (ci#62).
 *
 * Reconciles two independently-drifted donor pairs:
 * - MuscleBuddy's `deploy-target.mjs`/`vercel-ignore.mjs`: ref-only (dev,
 *   release/*, production), plus a `surface` escape hatch for a second
 *   Vercel project on the same repo that only ever deploys its own
 *   production branch.
 * - RedThreadEvents': ref PLUS a changed-paths gate, because their CI never
 *   builds the frontend at all — Vercel's per-PR build is the only frontend
 *   build check that exists, so a wrong skip there means a change ships
 *   built by nothing.
 *
 * FAILS OPEN in every direction both donors agreed on: an empty ref, an
 * unrecognised ref with no configured path list, or changed paths that could
 * not be computed all build. A wrong build costs one build; a wrong skip
 * silently strands a change undeployed and nothing says so.
 *
 * Plain JS with no dependencies, importable for its pure `deployDecision`
 * (unit/fixture testing) and runnable directly as a CLI that reads its
 * config from `DT_*` env vars — see `action.yml`, which is the only normal
 * caller.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

/**
 * @param {string} path
 * @param {string[]} prefixes trailing `/` = prefix match, otherwise exact
 */
function matchesAny(path, prefixes) {
  return prefixes.some((prefix) => (prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix));
}

/**
 * @param {{
 *   vercelEnv?: string,
 *   gitRef?: string,
 *   changedPaths?: string[] | null,
 *   pathPrefixes?: string[],
 *   alwaysBuildRefs?: string[],
 *   alwaysBuildRefPrefixes?: string[],
 *   forceSkip?: boolean,
 *   forceSkipReason?: string,
 * }} [opts]
 * @returns {{ build: boolean, reason: string }}
 */
export function deployDecision({
  vercelEnv,
  gitRef,
  changedPaths,
  pathPrefixes = [],
  alwaysBuildRefs = [],
  alwaysBuildRefPrefixes = [],
  forceSkip = false,
  forceSkipReason,
} = {}) {
  if (vercelEnv === 'production') {
    return { build: true, reason: 'production deploy' };
  }
  if (forceSkip) {
    return { build: false, reason: forceSkipReason || 'force-skip is set' };
  }

  const ref = (gitRef ?? '').trim();
  if (ref === '') {
    return { build: true, reason: 'no branch ref available — failing open' };
  }
  if (alwaysBuildRefs.includes(ref)) {
    return { build: true, reason: `'${ref}' is a deploy surface, not a feature branch` };
  }
  if (alwaysBuildRefPrefixes.some((prefix) => ref.startsWith(prefix))) {
    return { build: true, reason: `'${ref}' matches a deploy-surface ref prefix` };
  }

  if (pathPrefixes.length === 0) {
    // No path list configured: a ref-only gate, matching MuscleBuddy's shape.
    return { build: false, reason: `'${ref}' is a feature branch` };
  }

  if (changedPaths == null) {
    return { build: true, reason: 'changed paths could not be determined — failing open' };
  }
  if (changedPaths.length === 0) {
    return { build: true, reason: 'empty diff — failing open' };
  }

  const hits = changedPaths.filter((path) => matchesAny(path, pathPrefixes));
  if (hits.length > 0) {
    return { build: true, reason: `matched paths (${hits.slice(0, 3).join(', ')})` };
  }
  return {
    build: false,
    reason: `no matching paths in ${changedPaths.length} changed path(s) on '${ref}'`,
  };
}

// --- CLI, used only by action.yml's `run:` step -----------------------

function splitList(value, sep) {
  return (value ?? '')
    .split(sep)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/**
 * Paths changed since `DT_BASE_SHA`, or null when that cannot be established
 * (no base configured, a shallow clone that does not reach it, git
 * unavailable). `DT_CHANGED_PATHS`, when set, always wins — it lets a caller
 * hand in paths it already computed (e.g. `dorny/paths-filter`) instead of
 * asking this script to reproduce that diff.
 */
function computeChangedPaths() {
  const provided = process.env.DT_CHANGED_PATHS ?? '';
  if (provided.trim() !== '') {
    return splitList(provided, '\n');
  }

  const base = (process.env.DT_BASE_SHA ?? '').trim();
  if (base === '') return null;

  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
    const out = execFileSync('git', ['diff', '--name-only', base, 'HEAD'], { encoding: 'utf8' });
    return out.split('\n').filter((line) => line !== '');
  } catch {
    return null;
  }
}

function main() {
  const mode = (process.env.DT_MODE ?? 'decide').trim();

  const decision = deployDecision({
    vercelEnv: process.env.DT_VERCEL_ENV,
    gitRef: process.env.DT_GIT_REF,
    changedPaths: computeChangedPaths(),
    pathPrefixes: splitList(process.env.DT_PATHS, '\n'),
    alwaysBuildRefs: splitList(process.env.DT_ALWAYS_BUILD_REFS, ','),
    alwaysBuildRefPrefixes: splitList(process.env.DT_ALWAYS_BUILD_REF_PREFIXES, ','),
    forceSkip: (process.env.DT_FORCE_SKIP ?? 'false').trim().toLowerCase() === 'true',
    forceSkipReason: process.env.DT_FORCE_SKIP_REASON,
  });

  console.log(decision.build ? `Building: ${decision.reason}.` : `Skipping build: ${decision.reason}.`);

  if (mode === 'vercel-ignore') {
    // Vercel's Ignored Build Step contract is inverted from the usual
    // reading: exit 1 = BUILD (the step "failed" to ignore it), exit 0 =
    // SKIP. Getting it backwards skips production, so the decision is
    // printed above either way — the build log is the only place this is
    // observable. This mode is for a caller that runs this file directly as
    // `vercel.json`'s `ignoreCommand`, outside any Actions context.
    process.exit(decision.build ? 1 : 0);
  }

  // 'decide' mode (the composite action's own step): never fail the step
  // over a 'skip' decision — the caller reads `outputs.build` in an `if:`
  // instead, the same way a paths-filter output is consumed.
  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) {
    appendFileSync(githubOutput, `build=${decision.build}\n`);
    appendFileSync(githubOutput, `reason=${decision.reason}\n`);
  }
  process.exit(0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

#!/usr/bin/env node
/**
 * Fails when a GitHub Action reference in a workflow tree is unsafe: a
 * third-party action on a mutable tag, an org-owned action tracking a
 * branch, or the same action pinned to more than one major version across
 * the tree.
 *
 * This is the union of four rule sets that diverged across the fleet:
 *
 *   - platform's `check-action-pins.mjs` — SHA-pin third-party actions,
 *     exempt `actions`/`github`, and flag major-version skew of one action
 *     across the whole workflow directory.
 *   - RedThreadEvents' `check-action-pins.mjs` — the same SHA-pin rule, plus
 *     refusing `GarrettMakesItLLC/*@main` (or any other branch name):
 *     unreviewed CI on this repo, run with this repo's own token, changing
 *     underneath the consumer on someone else's push.
 *   - SideQuest's `checkActionPins.ts` — the same SHA-pin rule and
 *     `TRUSTED_OWNERS` shape, in TypeScript.
 *   - MuscleBuddy's `third-party-action-pinning.test.ts` — the same rule,
 *     but with `owner === 'GarrettMakesItLLC'` blanket-exempted alongside
 *     `actions`. That exemption is the defect this action must not repeat:
 *     an org-owned `@main` reference has to fail, not pass, because it is
 *     exactly the "unreviewed push repoints my CI" hole RedThreadEvents'
 *     copy already closed.
 *
 * Three gates, each independently switchable via inputs:
 *
 *   1. Third-party actions (owner not in `trusted-owners`, and not this
 *      org) must be pinned to a 40-character commit SHA. A tag is a moving
 *      pointer the action's own owner (or anyone who compromises that
 *      account) can repoint after review — this is the `tj-actions/
 *      changed-files` shape (March 2025).
 *   2. `require-release-tag-for-org` (default on): `GarrettMakesItLLC/*`
 *      may stay on a version tag (this org's own convention — see the `ci`
 *      repo's own README), but never on `@main`/`@master`/`@develop`/
 *      `@dev`/`@HEAD` or any other branch name. A branch on an org-owned
 *      action is the same "whoever pushes there controls my CI" hole a
 *      third-party mutable tag is, just with a shorter blast radius.
 *   3. `enforce-single-major` (default on): the same action pinned to two
 *      different MAJOR versions across the tree is drift nobody sees, since
 *      every individual line is valid on its own — a workflow left behind
 *      on `actions/checkout@v5` while the rest of the fleet moved to `v7`.
 *      SHA-pinned third-party refs carry no version number and are excluded
 *      from this comparison; only tag-style refs (`vN`, `vN.N.N`) count.
 *
 * A branch reference (no `@ref` at all, or a ref matching the well-known
 * branch names) is always rejected, regardless of owner or trust tier — a
 * missing ref floats to the action's default branch, which is exactly the
 * hazard this whole check exists to close.
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

const SHA = /^[0-9a-f]{40}$/;
const BRANCHY = /^(main|master|develop|dev|HEAD)$/;
const MAJOR = /^v?(\d+)(?:\.\d+)*$/;
const USES = /^\s*(?:-\s*)?uses:\s*(\S+)/;
const ORG = 'GarrettMakesItLLC';

/**
 * @typedef {{ file: string, line: number, uses: string, reason: string }} Violation
 */

/**
 * Parse a `uses:` value into its pieces, or null for a reference this check
 * does not apply to (local composite action, container image).
 * @param {string} raw
 * @returns {{ repoRef: string, owner: string, ref: string | undefined } | null}
 */
function parseUses(raw) {
  if (raw.startsWith('./') || raw.startsWith('docker://')) return null;
  const at = raw.lastIndexOf('@');
  const repoRef = at === -1 ? raw : raw.slice(0, at);
  const ref = at === -1 ? undefined : raw.slice(at + 1);
  const owner = repoRef.split('/')[0];
  if (!owner) return null;
  return { repoRef, owner, ref };
}

/**
 * Every `uses:` line in `text`, whether or not it is list-item prefixed.
 * A commented-out example is documentation, not something that runs.
 * @param {string} text
 * @returns {Array<{ line: number, raw: string }>}
 */
function usesLines(text) {
  const out = [];
  text.split('\n').forEach((raw, index) => {
    if (raw.trimStart().startsWith('#')) return;
    const match = USES.exec(raw);
    if (match?.[1]) out.push({ line: index + 1, raw: match[1] });
  });
  return out;
}

/**
 * @param {{ trustedOwners: Set<string>, requireReleaseTagForOrg: boolean }} opts
 */
function checkPins(text, file, opts) {
  /** @type {Violation[]} */
  const violations = [];

  for (const { line, raw } of usesLines(text)) {
    const parsed = parseUses(raw);
    if (!parsed) continue;
    const { owner, ref } = parsed;

    if (ref === undefined) {
      violations.push({ file, line, uses: raw, reason: 'has no @ref at all — floats to the default branch' });
      continue;
    }

    const isOrg = owner === ORG;
    const isTrusted = opts.trustedOwners.has(owner);

    if (BRANCHY.test(ref)) {
      if (isOrg) {
        if (opts.requireReleaseTagForOrg) {
          violations.push({
            file,
            line,
            uses: raw,
            reason: `tracks the '${ref}' branch of an org-owned action — pin a release tag or a commit SHA`,
          });
        }
        continue;
      }
      violations.push({
        file,
        line,
        uses: raw,
        reason: `tracks the '${ref}' branch — pin a release tag${isTrusted ? '' : ' (trusted owner) or a commit SHA (third party)'}`,
      });
      continue;
    }

    if (isOrg || isTrusted) continue;

    if (!SHA.test(ref)) {
      violations.push({
        file,
        line,
        uses: raw,
        reason: 'is a third-party action pinned to a mutable tag — use the 40-character commit SHA',
      });
    }
  }

  return violations;
}

/**
 * Every action referenced under more than one major version across `files`.
 * Keyed on owner/repo (not the full subpath): an action shipping multiple
 * entry points, e.g. `github/codeql-action/init` and `.../analyze`, ships
 * from one repository at one version and must move together.
 * @returns {Array<{ action: string, majors: Array<{ major: string, ref: string, file: string, line: number }> }>}
 */
function checkMajorSkew(files) {
  /** @type {Map<string, Array<{ major: string, ref: string, file: string, line: number }>>} */
  const seen = new Map();

  for (const { file, text } of files) {
    for (const { line, raw } of usesLines(text)) {
      const parsed = parseUses(raw);
      if (!parsed || parsed.ref === undefined) continue;
      const { repoRef, ref } = parsed;
      const majorMatch = MAJOR.exec(ref);
      // Only version-tag-shaped refs carry a comparable major; a SHA has no
      // version number to skew against.
      if (!majorMatch) continue;
      const action = repoRef.split('/').slice(0, 2).join('/');
      const at = seen.get(action) ?? [];
      at.push({ major: majorMatch[1], ref, file, line });
      seen.set(action, at);
    }
  }

  return [...seen.entries()]
    .filter(([, majors]) => new Set(majors.map((m) => m.major)).size > 1)
    .map(([action, majors]) => ({ action, majors }));
}

/**
 * @param {string} dir
 * @returns {Array<{ file: string, text: string }>}
 */
function readWorkflowDir(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.yml') || name.endsWith('.yaml'))
    .sort()
    .map((name) => {
      const file = path.join(dir, name);
      return { file, text: readFileSync(file, 'utf8') };
    });
}

function parseBool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return /^(true|1|yes)$/i.test(String(value).trim());
}

function main() {
  const workflowDir = process.env.WORKFLOW_DIR || process.argv[2] || '.github/workflows';
  const trustedOwners = new Set(
    (process.env.TRUSTED_OWNERS ?? 'actions,github')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const requireReleaseTagForOrg = parseBool(process.env.REQUIRE_RELEASE_TAG_FOR_ORG, true);
  const enforceSingleMajor = parseBool(process.env.ENFORCE_SINGLE_MAJOR, true);

  const files = readWorkflowDir(workflowDir);

  let failed = false;

  const violations = files.flatMap(({ file, text }) =>
    checkPins(text, file, { trustedOwners, requireReleaseTagForOrg }),
  );
  if (violations.length > 0) {
    failed = true;
    console.error(`Unsafe action reference(s) (${violations.length}):\n`);
    for (const v of violations) {
      console.error(`  ${v.file}:${v.line}  uses: ${v.uses}  — ${v.reason}`);
    }
    console.error('\nResolve a tag to its SHA with: gh api repos/<owner>/<repo>/git/ref/tags/<tag>');
    console.error('Then write it as `owner/repo@<sha> # <tag>`.\n');
  }

  if (enforceSingleMajor) {
    const skewed = checkMajorSkew(files);
    if (skewed.length > 0) {
      failed = true;
      console.error('An action must be referenced at one major version across every workflow:');
      for (const { action, majors } of skewed) {
        console.error(`  ${action}`);
        for (const { ref, file, line } of majors) {
          console.error(`    ${ref}  ${file}:${line}`);
        }
      }
      console.error('\nA workflow left behind on an old major is drift nobody reads —');
      console.error('every individual line is valid, which is why it survives review.\n');
    }
  }

  if (failed) process.exit(1);
  console.log('action pins: every reference is safely pinned');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { checkPins, checkMajorSkew, parseUses, usesLines, readWorkflowDir };

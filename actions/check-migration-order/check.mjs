#!/usr/bin/env node
// @ts-check
/**
 * CLI for check-migration-order: reads the base, head and trunk migration trees
 * out of git and judges them with `order.mjs`. Config arrives as MO_* env vars
 * (see action.yml, the only normal caller).
 */
import { execFileSync } from 'node:child_process';
import { auditMigrations } from './order.mjs';

const env = (k, d = '') => (process.env[k] ?? d).trim();
const list = (v) => v.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
const bool = (v, d) => (v === '' ? d : v.toLowerCase() === 'true');

const migrationsDir = env('MO_MIGRATIONS_DIR', 'prisma/migrations').replace(/\/+$/, '');
const headRef = env('MO_HEAD_REF', 'HEAD');
const githubBase = env('GITHUB_BASE_REF');
const baseRef = env('MO_BASE_REF') || (githubBase !== '' ? `origin/${githubBase}` : '');
const trunkRef = env('MO_TRUNK_REF', 'origin/dev');

const git = (/** @type {string[]} */ ...args) =>
  execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

function resolvable(/** @type {string} */ ref) {
  try {
    git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/** Fetch `origin/<branch>` shallowly when the checkout does not have it. */
function ensure(/** @type {string} */ ref) {
  if (resolvable(ref) || !ref.startsWith('origin/')) return resolvable(ref);
  const branch = ref.slice('origin/'.length);
  try {
    git('fetch', '--no-tags', '--depth=1', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  } catch {
    /* judged below */
  }
  return resolvable(ref);
}

/** Directory name -> `migration.sql` blob id at `ref`. */
function readTree(/** @type {string} */ ref) {
  const out = git('ls-tree', '-r', ref, '--', `${migrationsDir}/`);
  /** @type {Map<string, string>} */
  const tree = new Map();
  for (const line of out.split('\n')) {
    const m = /^\d+ blob ([0-9a-f]+)\t(.+)$/.exec(line);
    if (m === null) continue;
    const rel = /** @type {string} */ (m[2]).slice(migrationsDir.length + 1).split('/');
    if (rel.length === 2 && rel[1] === 'migration.sql') tree.set(/** @type {string} */ (rel[0]), /** @type {string} */ (m[1]));
  }
  return tree;
}

function commitNowMs() {
  const override = Number(env('MO_NOW_MS'));
  if (Number.isFinite(override) && override > 0) return override;
  try {
    // The verdict is a property of the commit, not of when the check ran.
    const ms = Number(git('show', '-s', '--format=%ct', headRef).trim()) * 1000;
    return Number.isFinite(ms) && ms > 0 ? ms : Date.now();
  } catch {
    return Date.now();
  }
}

if (baseRef === '') {
  console.error('::error::no base ref: pass `base-ref`, or run on a pull_request event (GITHUB_BASE_REF).');
  process.exit(1);
}
if (!ensure(baseRef)) {
  console.error(`::error::base ref "${baseRef}" is not available and could not be fetched.`);
  process.exit(1);
}
const base = readTree(baseRef);
const head = readTree(headRef);
if (head.size === 0) {
  console.error(`::error::no migrations under ${migrationsDir} at ${headRef}. Wrong migrations-dir? A check of nothing passes everything.`);
  process.exit(1);
}
// A promotion inherits every migration the trunk accumulated; they were judged
// when they merged there and re-judging can only ever block.
const settled = trunkRef !== '' && trunkRef !== baseRef && ensure(trunkRef) ? [...readTree(trunkRef).keys()] : [];

const { findings, warnings } = auditMigrations({
  base,
  head,
  settled,
  nowMs: commitNowMs(),
  roundHour: bool(env('MO_ROUND_HOUR'), true),
  allowRoundHour: list(env('MO_ALLOW_ROUND_HOUR')),
  allowCollisions: env('MO_ALLOW_COLLISIONS')
    .split('\n')
    .map((l) => list(l))
    .filter((g) => g.length > 0),
  immutability: bool(env('MO_IMMUTABILITY'), true),
});

for (const w of warnings) console.warn(`::warning title=Migration order::${w}`);
if (findings.length > 0) {
  for (const f of findings) console.error(`::error title=Migration ${f.rule}::${f.message}`);
  console.error(`\ncheck-migration-order: ${findings.length} problem(s) against ${baseRef}.`);
  process.exit(1);
}
console.log(`OK: migrations added on top of ${baseRef} are in order, off the round hour and not future-dated.`);

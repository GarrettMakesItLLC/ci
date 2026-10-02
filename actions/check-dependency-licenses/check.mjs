#!/usr/bin/env node
/**
 * Fail-closed licence gate for a repo's production dependency tree.
 *
 * Reads `package-lock.json` (npm computes the production/dev split across every
 * workspace when it writes `dev: true`) and judges each third-party package's
 * licence against an ALLOWLIST through a real SPDX-expression parser. A licence
 * the allowlist has not seen is a failure, never a pass: `SEE LICENSE IN ...`,
 * `Commons-Clause`, `BUSL-1.1`, `UNLICENSED` and a missing licence field all
 * fail. A denylist of copyleft prefixes cannot do that, because it passes every
 * string nobody thought to enumerate.
 *
 * Dependency-free plain node: the SPDX grammar needed here (ids, `+`, WITH,
 * AND, OR, parentheses) is small, and an action that installed a parser at run
 * time would be unpinned code in every consumer's pipeline.
 */
import fs from 'node:fs';
import path from 'node:path';

/** Permissive licences cleared for shipping inside closed-source code. */
export const DEFAULT_ALLOWED = [
  '0BSD',
  'Apache-2.0',
  'Artistic-2.0',
  'BlueOak-1.0.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BSD-3-Clause-Clear',
  'BSD-4-Clause',
  'CC-BY-3.0',
  'CC-BY-4.0',
  'CC0-1.0',
  'ISC',
  'MIT',
  'MIT-0',
  'PSF-2.0',
  'Python-2.0',
  'Unlicense',
  'WTFPL',
  'Zlib',
];

/** `X WITH <exception>` is allowed only for exceptions that loosen, never tighten. */
export const ALLOWED_EXCEPTIONS = ['LLVM-exception'];

/** Families named in a refusal so it says what it found; every one still fails unless allowed. */
const KNOWN_RESTRICTED =
  /^(A?GPL|LGPL|MPL|EPL|CDDL|SSPL|BUSL|BSL|OSL|EUPL|CPAL|RPL|CC-BY-NC|CC-BY-SA|Commons-Clause|UNLICENSED)/i;

/**
 * @param {string} text
 * @returns {{ type: 'license', id: string, plus: boolean } | { type: 'and' | 'or', left: any, right: any } | { type: 'with', license: any, exception: string }}
 * @throws {Error} on anything that is not a valid SPDX expression
 */
export function parseSpdx(text) {
  const tokens = text.match(/\(|\)|[^\s()]+/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const isOp = (t, op) => t !== undefined && t.toUpperCase() === op;

  function parseLicense() {
    const t = next();
    if (t === undefined) throw new Error('unexpected end of expression');
    if (t === '(') {
      const inner = parseOr();
      if (next() !== ')') throw new Error('missing )');
      return inner;
    }
    if (t === ')' || isOp(t, 'AND') || isOp(t, 'OR') || isOp(t, 'WITH')) {
      throw new Error(`unexpected "${t}"`);
    }
    if (!/^[A-Za-z0-9.\-]+\+?$/.test(t)) throw new Error(`invalid identifier "${t}"`);
    const plus = t.endsWith('+');
    const id = plus ? t.slice(0, -1) : t;
    if (isOp(peek(), 'WITH')) {
      next();
      const ex = next();
      if (ex === undefined || !/^[A-Za-z0-9.\-]+$/.test(ex)) throw new Error('bad WITH exception');
      return { type: 'with', license: { type: 'license', id, plus }, exception: ex };
    }
    return { type: 'license', id, plus };
  }
  function parseAnd() {
    let left = parseLicense();
    while (isOp(peek(), 'AND')) {
      next();
      left = { type: 'and', left, right: parseLicense() };
    }
    return left;
  }
  function parseOr() {
    let left = parseAnd();
    while (isOp(peek(), 'OR')) {
      next();
      left = { type: 'or', left, right: parseAnd() };
    }
    return left;
  }

  const tree = parseOr();
  if (i !== tokens.length) throw new Error(`unexpected "${tokens[i]}"`);
  return tree;
}

function leaves(node, out = []) {
  if (node.type === 'license') out.push(node.id);
  else if (node.type === 'with') out.push(`${node.license.id} WITH ${node.exception}`);
  else {
    leaves(node.left, out);
    leaves(node.right, out);
  }
  return out;
}

/**
 * AND needs every operand allowed (all obligations apply); OR needs one (we may
 * pick the permissive branch).
 */
function allowedNode(node, allowed) {
  switch (node.type) {
    case 'license':
      return allowed.has(node.id);
    case 'with':
      return allowed.has(node.license.id) && ALLOWED_EXCEPTIONS.includes(node.exception);
    case 'and':
      return allowedNode(node.left, allowed) && allowedNode(node.right, allowed);
    default:
      return allowedNode(node.left, allowed) || allowedNode(node.right, allowed);
  }
}

/**
 * @param {string | undefined} license
 * @param {Set<string>} allowed
 * @returns {{ status: 'allowed' | 'denied' | 'unknown', leaves: string[] }}
 */
export function classifyLicense(license, allowed = new Set(DEFAULT_ALLOWED)) {
  if (typeof license !== 'string' || license.trim() === '') return { status: 'unknown', leaves: [] };
  const text = license.trim();
  if (text === 'UNLICENSED') return { status: 'denied', leaves: ['UNLICENSED'] };
  let tree;
  try {
    tree = parseSpdx(text);
  } catch {
    // Real-world lowercase operators (`MIT or Apache-2.0`) are tolerated; anything else is unknown.
    return { status: 'unknown', leaves: [] };
  }
  const ls = leaves(tree);
  if (allowedNode(tree, allowed)) return { status: 'allowed', leaves: ls };
  const restricted = ls.some((l) => KNOWN_RESTRICTED.test(l));
  return { status: restricted ? 'denied' : 'unknown', leaves: ls };
}

function nameFromPath(pkgPath) {
  const idx = pkgPath.lastIndexOf('node_modules/');
  return idx === -1 ? pkgPath : pkgPath.slice(idx + 'node_modules/'.length);
}

/** Legacy `license: {type}` and `licenses: [{type}]` shapes an installed manifest may still carry. */
function licenseFromManifest(manifest) {
  if (typeof manifest.license === 'string') return manifest.license;
  if (manifest.license && typeof manifest.license.type === 'string') return manifest.license.type;
  if (Array.isArray(manifest.licenses) && manifest.licenses.length > 0) {
    return manifest.licenses.map((l) => l.type).join(' OR ');
  }
  return undefined;
}

function resolveLicense(pkgPath, entry, repoRoot) {
  if (typeof entry.license === 'string') return entry.license;
  if (entry.license && typeof entry.license.type === 'string') return entry.license.type;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, pkgPath, 'package.json'), 'utf8'));
    return licenseFromManifest(manifest);
  } catch {
    return undefined;
  }
}

/** The lockfile entry a dependency name resolves to from `fromPath`, nearest node_modules first. */
function resolveFrom(packages, fromPath, name) {
  let dir = fromPath;
  for (;;) {
    const candidate = dir === '' ? `node_modules/${name}` : `${dir}/node_modules/${name}`;
    if (candidate in packages) return candidate;
    if (dir === '') return undefined;
    dir = dir.includes('/') ? dir.slice(0, dir.lastIndexOf('/')) : '';
  }
}

/** Lockfile paths reachable from the given workspace roots through non-dev dependencies. */
function reachableFrom(packages, workspaces) {
  const found = new Set();
  const seen = new Set();
  const queue = [];
  for (const ws of workspaces) {
    if (!(ws in packages)) throw new Error(`no "${ws}" entry in the lockfile`);
    queue.push(ws);
  }
  while (queue.length > 0) {
    const from = queue.pop();
    const entry = packages[from];
    for (const name of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
      const resolved = resolveFrom(packages, from, name);
      if (resolved === undefined || seen.has(resolved)) continue;
      seen.add(resolved);
      const dep = packages[resolved];
      if (dep.dev === true) continue;
      if (dep.link === true && dep.resolved !== undefined && dep.resolved in packages) {
        queue.push(dep.resolved);
        continue;
      }
      found.add(resolved);
      queue.push(resolved);
    }
  }
  return found;
}

/**
 * Every production-reachable third-party package, deduped by name@version.
 * @param {{ packages?: Record<string, any> }} lockfile
 * @param {{ repoRoot?: string, ownPrefixes?: string[], workspaces?: string[], scope?: 'prod' | 'all' }} [opts]
 */
export function collectPackages(lockfile, opts = {}) {
  const { repoRoot = '.', ownPrefixes = [], workspaces = [], scope = 'prod' } = opts;
  const packages = lockfile.packages;
  if (packages === undefined || typeof packages !== 'object') {
    throw new Error('lockfile has no "packages" map (lockfileVersion 2 or 3 required)');
  }
  const reach = workspaces.length > 0 ? reachableFrom(packages, workspaces) : null;
  const seen = new Map();
  for (const [pkgPath, entry] of Object.entries(packages)) {
    if (pkgPath === '' || !pkgPath.includes('node_modules/')) continue;
    if (entry.link) continue;
    if (reach !== null ? !reach.has(pkgPath) : scope === 'prod' && entry.dev) continue;
    const name = nameFromPath(pkgPath);
    if (ownPrefixes.some((p) => name.startsWith(p))) continue;
    const key = `${name}@${entry.version ?? ''}`;
    if (seen.has(key)) continue;
    seen.set(key, {
      name,
      version: entry.version ?? '',
      license: resolveLicense(pkgPath, entry, repoRoot),
    });
  }
  return [...seen.values()];
}

function matchesException(pkg, ex) {
  const nameOk = ex.name.endsWith('*') ? pkg.name.startsWith(ex.name.slice(0, -1)) : pkg.name === ex.name;
  if (!nameOk) return false;
  if (ex.version !== undefined && ex.version !== pkg.version) return false;
  // The exception was granted for a specific licence; a changed licence voids it.
  if (ex.license !== undefined && ex.license !== (pkg.license ?? '(none)')) return false;
  return true;
}

/**
 * @param {ReturnType<typeof collectPackages>} packages
 * @param {{ allowed?: Set<string>, exceptions?: any[] }} [opts]
 */
export function scan(packages, { allowed = new Set(DEFAULT_ALLOWED), exceptions = [] } = {}) {
  const result = { allowed: [], excepted: [], denied: [], unknown: [] };
  for (const pkg of packages) {
    const { status, leaves: ls } = classifyLicense(pkg.license, allowed);
    if (status === 'allowed') {
      result.allowed.push(pkg);
      continue;
    }
    const ex = exceptions.find((e) => matchesException(pkg, e));
    if (ex) result.excepted.push({ ...pkg, reason: ex.reason });
    else result[status].push({ ...pkg, leaves: ls });
  }
  return result;
}

const list = (v) =>
  (v ?? '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

function main() {
  const lockfilePath = process.env.LICENSE_LOCKFILE || 'package-lock.json';
  const exceptionsFile = process.env.LICENSE_EXCEPTIONS_FILE || '';
  const minPackages = Number(process.env.LICENSE_MIN_PACKAGES || '1');
  const scope = process.env.LICENSE_SCOPE === 'all' ? 'all' : 'prod';
  const allowed = new Set([...DEFAULT_ALLOWED, ...list(process.env.LICENSE_ALLOW_EXTRA)]);

  const lockfile = JSON.parse(fs.readFileSync(lockfilePath, 'utf8'));
  let exceptions = [];
  if (exceptionsFile !== '') {
    exceptions = JSON.parse(fs.readFileSync(exceptionsFile, 'utf8'));
    const bad = exceptions.filter((e) => typeof e.name !== 'string' || !e.reason);
    if (bad.length > 0) {
      console.error('::error::every exception needs a name and a reason');
      process.exit(1);
    }
  }
  const packages = collectPackages(lockfile, {
    repoRoot: path.dirname(path.resolve(lockfilePath)),
    ownPrefixes: list(process.env.LICENSE_OWN_PREFIXES ?? '@gmi/,@garrettmakesitllc/'),
    workspaces: list(process.env.LICENSE_WORKSPACES),
    scope,
  });
  // A scan that inspects nothing passes everything.
  if (packages.length < minPackages) {
    console.error(
      `::error::inspected ${packages.length} package(s), expected at least ${minPackages}. The tree failed to resolve; refusing to report a pass on an empty scan.`,
    );
    process.exit(1);
  }
  const r = scan(packages, { allowed, exceptions });
  console.log(
    `Licence scan: ${packages.length} package(s) (${r.allowed.length} allowed, ${r.excepted.length} excepted, ${r.denied.length} denied, ${r.unknown.length} unreviewed/unknown).`,
  );
  for (const p of r.excepted) console.log(`  excepted ${p.name}@${p.version} ${p.license ?? '(none)'}: ${p.reason}`);
  for (const p of r.denied) {
    console.error(`::error title=Denied licence::${p.name}@${p.version} ${JSON.stringify(p.license)} (${p.leaves.join(', ')})`);
  }
  for (const p of r.unknown) {
    console.error(
      `::error title=Unreviewed licence::${p.name}@${p.version} ${p.license === undefined ? 'has no licence recorded' : `licence ${JSON.stringify(p.license)} is not on the allowlist`}`,
    );
  }
  if (r.denied.length + r.unknown.length > 0) {
    console.error(
      '\nReplace the dependency, add a reviewed licence via `allow-extra`, or record a justified exception (name, exact licence, reason) in the exceptions file.',
    );
    process.exit(1);
  }
  console.log('No denied or unreviewed production licences.');
}

if (import.meta.url === `file://${process.argv[1]}`) main();

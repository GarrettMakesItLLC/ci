#!/usr/bin/env node
/**
 * Drift gate for a file vendored from this repo.
 *
 * Some consumers cannot `uses:` an action: Vercel's `ignoreCommand` runs outside
 * Actions, and a local replica runs outside a runner, so `deploy-target.mjs` and
 * `pr-body-lint/lint.mjs` are copied verbatim. A copy nothing checks goes stale
 * silently. This compares the vendored file's CODE with this repo's file at an
 * IMMUTABLE ref (a full SHA or a `vN.N.N` tag): comments, whitespace and the
 * `export` keyword do not count; a logic change does. The ref is the pin, so the
 * gate is deterministic and a new release here never reddens a consumer; bumping
 * the pin is a deliberate re-copy.
 *
 * `latest-ref` (e.g. `v1`) is advisory: a copy that differs from it warns.
 */
import fs from 'node:fs';

/** Code only, so a comment edit or a formatter re-wrap does not read as drift. */
export function normalizedCode(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/export /g, '')
    .replace(/,(\s*[)\]}])/g, '$1')
    .replace(/\s*([{}()[\],;:=<>+\-*/&|?!])\s*/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A ref that cannot move: a full commit SHA or an immutable release tag. */
export function isImmutableRef(ref) {
  return /^[0-9a-f]{40}$/.test(ref) || /^v\d+\.\d+\.\d+$/.test(ref);
}

async function fetchUpstream({ repo, ref, path, token }) {
  const url = `https://raw.githubusercontent.com/${repo}/${ref}/${path}`;
  let last = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      if (res.ok) return await res.text();
      last = `HTTP ${res.status}`;
      if (res.status === 404) break; // a wrong ref or path will not heal
    } catch (e) {
      last = e.message;
    }
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  throw new Error(`could not read ${url}: ${last}`);
}

async function main() {
  const env = (k, d = '') => (process.env[k] ?? d).trim();
  const vendoredPath = env('VC_VENDORED_PATH');
  const upstreamPath = env('VC_UPSTREAM_PATH');
  const ref = env('VC_REF');
  const repo = env('VC_REPO', 'GarrettMakesItLLC/ci');
  const localUpstream = env('VC_UPSTREAM_FILE');
  const latestRef = env('VC_LATEST_REF');
  const token = env('VC_TOKEN');
  const fail = (m) => {
    console.error(`::error title=Vendored copy::${m}`);
    process.exit(1);
  };

  if (vendoredPath === '' || upstreamPath === '' || ref === '') fail('vendored-path, upstream-path and ref are required');
  if (!isImmutableRef(ref) && env('VC_ALLOW_MUTABLE_REF') !== 'true') {
    fail(`ref "${ref}" can move. Pin a full commit SHA or a vN.N.N release tag so the verdict is a property of the pin.`);
  }
  let vendored;
  try {
    vendored = fs.readFileSync(vendoredPath, 'utf8');
  } catch (e) {
    fail(`cannot read ${vendoredPath}: ${e.message}`);
  }
  const read = (r) => (localUpstream !== '' ? fs.readFileSync(localUpstream, 'utf8') : fetchUpstream({ repo, ref: r, path: upstreamPath, token }));
  let upstream;
  try {
    upstream = await read(ref);
  } catch (e) {
    fail(e.message);
  }
  if (normalizedCode(vendored) !== normalizedCode(upstream)) {
    fail(
      `${vendoredPath} no longer matches ${repo} ${upstreamPath}@${ref}. Re-copy it verbatim from that ref ` +
        `(keep it out of the formatter's reach), or move the pin if you meant to take a newer version.`,
    );
  }
  console.log(`${vendoredPath} matches ${upstreamPath}@${ref}.`);

  if (latestRef !== '' && localUpstream === '') {
    try {
      const latest = await fetchUpstream({ repo, ref: latestRef, path: upstreamPath, token });
      if (normalizedCode(vendored) !== normalizedCode(latest)) {
        console.warn(`::warning title=Vendored copy is behind::${vendoredPath} differs from ${upstreamPath}@${latestRef}; re-copy and move the pin when convenient.`);
      }
    } catch (e) {
      console.warn(`::warning title=Vendored copy::could not read ${latestRef} to check for a newer version: ${e.message}`);
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) await main();

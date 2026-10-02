import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isImmutableRef, normalizedCode } from './check.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const upstream = path.join(here, '../deploy-target/deploy-target.mjs');
const src = readFileSync(upstream, 'utf8');
const sha = (s) => normalizedCode(s);

test('a comment edit, a re-wrap and a trailing comma are not drift', () => {
  assert.equal(sha(`// note\n${src}`), sha(src));
  assert.equal(sha(src.replace('export function', 'function')), sha(src));
  assert.equal(sha('f(a,\n  b,\n)'), sha('f(a, b)'));
});

test('a logic change is drift', () => {
  const edited = src.replace("alwaysBuildRefs.includes(ref)", 'false');
  assert.notEqual(edited, src);
  assert.notEqual(sha(edited), sha(src));
  assert.notEqual(sha(src.replace("'production'", "'preview'")), sha(src));
});

test('only an immutable ref is a pin', () => {
  assert.ok(isImmutableRef('a'.repeat(40)));
  assert.ok(isImmutableRef('v1.4.2'));
  for (const bad of ['v1', 'main', 'v1.2', 'abc123']) assert.equal(isImmutableRef(bad), false, bad);
});

function cli(vendored, env = {}) {
  try {
    const out = execFileSync('node', [path.join(here, 'check.mjs')], {
      encoding: 'utf8',
      stdio: 'pipe',
      env: { ...process.env, VC_VENDORED_PATH: vendored, VC_UPSTREAM_PATH: 'actions/deploy-target/deploy-target.mjs', VC_REF: 'v1.0.0', VC_UPSTREAM_FILE: upstream, ...env },
    });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test('cli: matching copy passes, drifted copy fails, moving ref is refused', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'vc-'));
  const good = path.join(dir, 'good.mjs');
  const bad = path.join(dir, 'bad.mjs');
  writeFileSync(good, `// vendored\n${src}`);
  writeFileSync(bad, src.replace('alwaysBuildRefs.includes(ref)', 'false'));
  assert.equal(cli(good).rc, 0);
  const r = cli(bad);
  assert.equal(r.rc, 1);
  assert.match(r.out, /no longer matches/);
  assert.equal(cli(good, { VC_REF: 'v1' }).rc, 1);
  assert.equal(cli(path.join(dir, 'missing.mjs')).rc, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyLicense, collectPackages, parseSpdx, scan } from './check.mjs';

const status = (l) => classifyLicense(l).status;

// The rows NetWorthy's denylist let through. Each must fail closed.
test('regression: licences a denylist passes silently are failures', () => {
  assert.equal(status('SEE LICENSE IN LICENSE.md'), 'unknown');
  assert.equal(status('Commons-Clause'), 'denied');
  assert.equal(status('MIT AND Commons-Clause'), 'denied');
  assert.equal(status(undefined), 'unknown');
  assert.equal(status(''), 'unknown');
  assert.equal(status('BUSL-1.1'), 'denied');
  assert.equal(status('UNLICENSED'), 'denied');
  assert.equal(status('GPL-3.0-only'), 'denied');
  assert.equal(status('Some-Brand-New-Licence-1.0'), 'unknown');
});

test('permissive licences and SPDX operators', () => {
  assert.equal(status('MIT'), 'allowed');
  assert.equal(status('(MIT OR GPL-2.0)'), 'allowed');
  assert.equal(status('(MIT AND GPL-2.0)'), 'denied');
  assert.equal(status('Apache-2.0 AND MIT AND BSD-3-Clause'), 'allowed');
  assert.equal(status('MIT or Apache-2.0'), 'allowed');
  assert.equal(status('Apache-2.0 WITH LLVM-exception'), 'allowed');
  assert.equal(status('MIT WITH Commons-Clause'), 'unknown');
  assert.equal(status('Apache-2.0+'), 'allowed');
  assert.equal(status('MPL-2.0'), 'denied');
});

test('malformed expressions are unknown, not allowed', () => {
  for (const bad of ['(MIT', 'MIT AND', 'MIT OR OR ISC', 'MIT ISC', ')', 'MIT WITH']) {
    assert.equal(status(bad), 'unknown', bad);
  }
  assert.throws(() => parseSpdx('(MIT'));
});

test('allow-extra widens the allowlist', () => {
  assert.equal(classifyLicense('MPL-2.0', new Set(['MPL-2.0'])).status, 'allowed');
});

const lock = (packages) => ({ lockfileVersion: 3, packages });

test('collectPackages: prod scope, own prefixes, links, dedupe', () => {
  const pkgs = collectPackages(
    lock({
      '': {},
      'apps/web': {},
      'node_modules/a': { version: '1.0.0', license: 'MIT' },
      'node_modules/dev-only': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
      'node_modules/@gmi/x': { version: '1.0.0', license: 'UNLICENSED' },
      'node_modules/web': { link: true, resolved: 'apps/web' },
      'node_modules/b/node_modules/a': { version: '1.0.0', license: 'MIT' },
    }),
    { ownPrefixes: ['@gmi/'] },
  );
  assert.deepEqual(pkgs.map((p) => p.name).sort(), ['a']);
  assert.equal(collectPackages(lock({ 'node_modules/d': { version: '1', dev: true } }), { scope: 'all' }).length, 1);
});

test('collectPackages: a missing licence stays missing and fails the scan', () => {
  const pkgs = collectPackages(lock({ 'node_modules/nolic': { version: '1.0.0' } }), { repoRoot: '/nonexistent' });
  assert.equal(pkgs[0].license, undefined);
  assert.equal(scan(pkgs).unknown.length, 1);
});

test('collectPackages: workspaces walk the reachable non-dev closure', () => {
  const pkgs = collectPackages(
    lock({
      'apps/web': { dependencies: { a: '1', devish: '1' } },
      'apps/other': { dependencies: { z: '1' } },
      'node_modules/a': { version: '1.0.0', license: 'MIT', dependencies: { b: '1' } },
      'node_modules/b': { version: '1.0.0', license: 'ISC' },
      'node_modules/devish': { version: '1.0.0', license: 'GPL-3.0-only', dev: true },
      'node_modules/z': { version: '1.0.0', license: 'GPL-3.0-only' },
    }),
    { workspaces: ['apps/web'] },
  );
  assert.deepEqual(pkgs.map((p) => p.name).sort(), ['a', 'b']);
  assert.throws(() => collectPackages(lock({}), { workspaces: ['apps/nope'] }));
});

test('exceptions: need the exact recorded licence and stop applying when it changes', () => {
  const pkgs = [{ name: 'sharp-libvips-linux', version: '1.0.0', license: 'LGPL-3.0-or-later' }];
  const ex = [{ name: 'sharp-libvips-*', license: 'LGPL-3.0-or-later', reason: 'unmodified binary' }];
  assert.equal(scan(pkgs, { exceptions: ex }).excepted.length, 1);
  assert.equal(scan([{ ...pkgs[0], license: 'GPL-3.0-only' }], { exceptions: ex }).denied.length, 1);
  const missing = [{ name: 'format', version: '0.2.2', license: undefined }];
  assert.equal(scan(missing, { exceptions: [{ name: 'format', license: '(none)', reason: 'legacy field' }] }).excepted.length, 1);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { auditMigrations } from './order.mjs';

const NOW = Date.UTC(2026, 8, 28, 12, 0, 0);
const tree = (...names) => new Map(names.map((n) => [n, `blob-${n}`]));
const run = (base, head, extra = {}) => auditMigrations({ base: tree(...base), head: tree(...head), nowMs: NOW, ...extra });
const rules = (r) => r.findings.map((f) => `${f.rule}:${f.dir}`);

const A = '20260901101112_a';
const B = '20260902101112_b';

test('a clean addition passes', () => {
  assert.deepEqual(rules(run([A], [A, B])), []);
});

test('out-of-order: sorts before, or collides with, the newest on base', () => {
  assert.deepEqual(rules(run([B], [A, B])), [`out-of-order:${A}`]);
  assert.deepEqual(rules(run([B], [B, '20260902101112_other'])), ['out-of-order:20260902101112_other', 'duplicate-timestamp:20260902101112_other']);
});

test('future-dated: more than an hour past the commit clock', () => {
  assert.deepEqual(rules(run([A], [A, '20270101101112_late'])), ['future-dated:20270101101112_late']);
  assert.deepEqual(rules(run([A], [A, '20260928123012_slightly_ahead'])), []);
});

test('future-dated base relaxes the ceiling to just past it, and warns', () => {
  const stuck = '20270101101112_stuck';
  const r = run([stuck], [stuck, '20270101101213_after']);
  assert.deepEqual(rules(r), []);
  assert.equal(r.warnings.length, 1);
  assert.deepEqual(rules(run([stuck], [stuck, '20270301101112_way_later'])), ['future-dated:20270301101112_way_later']);
});

// Regression: NetWorthy and SideQuest never had this rule.
test('round-hour: refused unless baselined', () => {
  const dir = '20260903120000_rounded';
  assert.deepEqual(rules(run([A], [A, dir])), [`round-hour:${dir}`]);
  assert.deepEqual(rules(run([A], [A, dir], { allowRoundHour: [dir] })), []);
  assert.deepEqual(rules(run([A], [A, dir], { roundHour: false })), []);
});

// Regression: MuscleBuddy and NetWorthy never had this rule (only the newest was checked).
test('duplicate timestamps between two directories that both sort earlier', () => {
  const r = run([A], [A, '20260925101112_x', '20260925101112_y'], {});
  assert.deepEqual(rules(r), ['duplicate-timestamp:20260925101112_x']);
});

test('duplicate timestamps already settled on base are history; a baselined exact set is forgiven', () => {
  const old1 = '20260828130000_one';
  const old2 = '20260828130000_two';
  assert.deepEqual(rules(run([old1, old2, B], [old1, old2, B], { allowRoundHour: [old1, old2] })), []);
  const added = '20260903101112_new';
  const pair = ['20260903101112_new', '20260903101112_old'];
  // exact baseline forgives the pair but not a third directory
  const third = '20260903101112_third';
  const base = ['20260903101112_old'];
  const forgiven = run(base, [...base, added], { allowCollisions: [pair] });
  assert.ok(!rules(forgiven).some((r) => r.startsWith('duplicate-timestamp')));
  const notForgiven = run(base, [...base, added, third], { allowCollisions: [pair] });
  assert.ok(rules(notForgiven).some((r) => r.startsWith('duplicate-timestamp')));
});

// Regression: only AdventureOS had this half.
test('immutability: removed, renamed or edited applied migrations fail', () => {
  assert.deepEqual(rules(run([A, B], [B])), [`immutable:${A}`]);
  const edited = auditMigrations({ base: tree(A), head: new Map([[A, 'different-blob']]), nowMs: NOW });
  assert.deepEqual(rules(edited), [`immutable:${A}`]);
  assert.deepEqual(rules(run([A, B], [B], { immutability: false })), []);
});

test('promotion: settled trunk migrations are inherited, not re-judged', () => {
  const settled = ['20260905101112_dev_a', '20260905000000_dev_round', '20270101101112_dev_future'];
  const r = auditMigrations({ base: tree(A), head: tree(A, ...settled), settled, nowMs: NOW });
  assert.deepEqual(rules(r), []);
  // ...but a migration authored on the release branch is still judged against base
  const r2 = auditMigrations({ base: tree(B), head: tree(B, A), settled: [], nowMs: NOW });
  assert.deepEqual(rules(r2), [`out-of-order:${A}`]);
});

test('a new directory without a timestamp prefix is refused', () => {
  assert.deepEqual(rules(run([A], [A, 'oops'])), ['bad-name:oops']);
});

// --- the CLI against a real git repo ---------------------------------------
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), 'check.mjs');

function repo(files) {
  const dir = mkdtempSync(path.join(tmpdir(), 'mo-'));
  const git = (...a) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...a], { cwd: dir, encoding: 'utf8' });
  git('init', '-q', '-b', 'main');
  const write = (set) => {
    for (const [name, sql] of Object.entries(set)) {
      mkdirSync(path.join(dir, 'prisma/migrations', name), { recursive: true });
      writeFileSync(path.join(dir, 'prisma/migrations', name, 'migration.sql'), sql);
    }
  };
  write(files.base);
  git('add', '-A');
  git('commit', '-q', '-m', 'base');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  git('checkout', '-q', '-b', 'pr');
  write(files.head ?? {});
  git('add', '-A');
  git('commit', '-q', '-m', 'head');
  return dir;
}

function cli(dir, env = {}) {
  try {
    const out = execFileSync('node', [CLI], { cwd: dir, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, MO_BASE_REF: 'origin/main', MO_TRUNK_REF: '', MO_NOW_MS: String(NOW), ...env } });
    return { rc: 0, out };
  } catch (e) {
    return { rc: e.status, out: `${e.stdout}${e.stderr}` };
  }
}

test('cli: clean PR passes, round-hour and out-of-order PRs fail', () => {
  const ok = repo({ base: { [A]: 'select 1;' }, head: { [B]: 'select 2;' } });
  const bad = repo({ base: { [B]: 'select 1;' }, head: { '20260801120000_old_round': 'select 2;' } });
  try {
    assert.equal(cli(ok).rc, 0);
    const r = cli(bad);
    assert.equal(r.rc, 1);
    assert.match(r.out, /out-of-order/);
    assert.match(r.out, /round-hour/);
  } finally {
    rmSync(ok, { recursive: true, force: true });
    rmSync(bad, { recursive: true, force: true });
  }
});

test('cli: editing an applied migration fails; an empty migrations dir is an error', () => {
  const edit = repo({ base: { [A]: 'select 1;' }, head: { [A]: 'select 2;' } });
  const none = mkdtempSync(path.join(tmpdir(), 'mo-'));
  try {
    const r = cli(edit);
    assert.equal(r.rc, 1);
    assert.match(r.out, /migration\.sql changed/);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: none });
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'x'], { cwd: none });
    execFileSync('git', ['update-ref', 'refs/remotes/origin/main', 'HEAD'], { cwd: none });
    assert.equal(cli(none).rc, 1);
  } finally {
    rmSync(edit, { recursive: true, force: true });
    rmSync(none, { recursive: true, force: true });
  }
});

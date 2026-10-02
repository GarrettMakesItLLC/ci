import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { audit, jobs, nameExpression, possibleNames } from './check.mjs';

const fx = (dir, f) => readFileSync(new URL(`../../.github/fixtures/check-required-checks/${dir}/${f}`, import.meta.url), 'utf8');
const clean = { workflow: fx('clean', 'ci.yml'), manifest: JSON.parse(fx('clean', 'required-checks.json')) };
const problems = (over = {}) => audit({ ...clean, ...over });
const withWorkflow = (from, to) => ({ workflow: clean.workflow.replace(from, to) });

test('the clean fixture passes', () => {
  assert.deepEqual(problems(), []);
});

test('parses jobs only under `jobs:` and folds block-scalar names', () => {
  const j = jobs(clean.workflow);
  assert.deepEqual([...j.keys()], ['lint', 'ci-success', 'promotion-gate']);
  assert.deepEqual(possibleNames(nameExpression(j.get('promotion-gate'))), ['Promotion gate', 'Promotion gate (skipped lane)']);
  assert.deepEqual(possibleNames(nameExpression(j.get('ci-success'))), ['CI Success']);
});

// The failure the guard exists for: a static name on a promotion branch is emitted on every lane.
test('regression: a static name on a promotion branch is refused', () => {
  const static_ = withWorkflow(/name: >-\n\s+\$\{\{.*\}\}\n/, 'name: Promotion gate\n');
  const p = problems(static_);
  assert.equal(p.length, 1);
  assert.match(p[0], /static job name/);
});

test('a name emitted by no job, or by two jobs, is refused', () => {
  assert.match(problems({ manifest: { ...clean.manifest, main: ['Promotion gate', 'Nobody'] } })[0], /emitted by no job/);
  const dup = clean.workflow + '\n  other:\n    name: CI Success\n    runs-on: x\n';
  assert.ok(problems({ workflow: dup }).some((p) => /emitted by 2 jobs/.test(p)));
  assert.ok(problems({ workflow: dup }).some((p) => /can both report/.test(p)));
});

test('static CI Success is fine on a non-promotion branch and when inherited', () => {
  assert.deepEqual(problems({ manifest: { dev: ['CI Success'], main: ['Promotion gate'], inherited: { main: ['CI Success'] } } }), []);
});

test('promotion-branches empty means a single-tier repo may require a static name on main', () => {
  const m = { main: ['CI Success'], inherited: {} };
  assert.deepEqual(audit({ workflow: clean.workflow, manifest: m, promotionBranches: [] }), []);
  assert.ok(audit({ workflow: clean.workflow, manifest: m }).some((p) => /static job name/.test(p)));
});

test('the job `if:` may not be narrower than always() plus the lane condition', () => {
  const p = problems(withWorkflow('    if: always()\n    needs: [ci-success]', "    if: needs.ci-success.result == 'success'\n    needs: [ci-success]"));
  assert.ok(p.some((x) => /nothing narrower/.test(x)));
});

test('a name and its lane gate: missing base_ref is refused', () => {
  const p = problems(withWorkflow("github.base_ref == 'main'", "github.ref == 'refs/heads/x'"));
  assert.ok(p.some((x) => /base_ref/.test(x)));
});

test('gating and inherited overlap, empty branches, wrong integration id', () => {
  assert.ok(problems({ manifest: { ...clean.manifest, dev: ['CI Success'] } }).some((x) => /both gating and inherited/.test(x)));
  assert.ok(problems({ manifest: { main: [], dev: [], inherited: {} } }).some((x) => /requires no checks/.test(x)));
  assert.ok(problems({ manifest: { ...clean.manifest, integration_id: 1 } }).some((x) => /integration_id/.test(x)));
  assert.deepEqual(problems({ manifest: { ...clean.manifest, integration_id: 1 }, integrationId: null }), []);
});

test('`external` names are exempt from the emitter rule', () => {
  assert.deepEqual(problems({ manifest: { ...clean.manifest, main: ['Promotion gate', 'Vercel'], external: ['Vercel'] } }), []);
});

test('a workflow with no jobs fails rather than passing over nothing', () => {
  assert.equal(audit({ workflow: 'name: x\non: push\n', manifest: clean.manifest }).length, 1);
});

test('the violations fixture reports every rule', () => {
  const p = audit({ workflow: fx('violations', 'ci.yml'), manifest: JSON.parse(fx('violations', 'required-checks.json')) });
  for (const re of [/emitted by no job/, /static job name/, /can both report/, /integration_id/, /emitted by 2 jobs/]) {
    assert.ok(p.some((x) => re.test(x)), String(re));
  }
});

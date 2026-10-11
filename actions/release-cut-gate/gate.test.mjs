import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { cutGateDecision, rollupForbidden } from './gate.mjs';

const pr = (number, extra = {}) => ({ number, title: `PR ${number}`, isInMergeQueue: false, autoMergeRequest: null, rollup: 'SUCCESS', ...extra });
const ARMED = { enabledAt: '2026-10-10T00:00:00Z' };
const dispatch = { event: 'workflow_dispatch', force: false };
const decide = (over) => cutGateDecision({ queueEntries: [], openPrs: [], ...dispatch, ...over });

test('cuts when nothing is queued or armed', () => {
  const d = decide({ openPrs: [pr(1), pr(2)] });
  assert.equal(d.proceed, true);
  assert.equal(d.fail, false);
  assert.deepEqual(d.blockers, []);
});

test('refuses a manual cut while the merge queue has an entry, naming it', () => {
  const d = decide({ queueEntries: [{ state: 'AWAITING_CHECKS', pullRequest: { number: 7, title: 'queued thing' } }] });
  assert.equal(d.proceed, false);
  assert.equal(d.fail, true);
  assert.match(d.message, /#7 queued thing/);
  assert.match(d.message, /Cut after they land/);
});

test('ignores a queue entry GitHub already judged unmergeable', () => {
  assert.equal(decide({ queueEntries: [{ state: 'UNMERGEABLE', pullRequest: { number: 7, title: 'x' } }] }).proceed, true);
});

for (const rollup of ['PENDING', 'EXPECTED', 'SUCCESS', null]) {
  test(`refuses while an armed PR has ${rollup} checks`, () => {
    const d = decide({ openPrs: [pr(11, { autoMergeRequest: ARMED, rollup })] });
    assert.equal(d.fail, true);
    assert.deepEqual(d.blockers.map((b) => b.number), [11]);
  });
}

for (const rollup of ['FAILURE', 'ERROR']) {
  test(`does not wait on an armed PR whose checks are ${rollup}`, () => {
    assert.equal(decide({ openPrs: [pr(11, { autoMergeRequest: ARMED, rollup })] }).proceed, true);
  });
}

test('an unarmed PR is not about to land', () => {
  assert.equal(decide({ openPrs: [pr(11)] }).proceed, true);
});

test('refuses while a PR reports isInMergeQueue with no autoMergeRequest', () => {
  const d = decide({ openPrs: [pr(12, { isInMergeQueue: true, rollup: 'PENDING' })] });
  assert.equal(d.fail, true);
  assert.match(d.blockers[0].reason, /merge queue/);
});

test('lists a PR once when it is both a queue entry and an armed open PR', () => {
  const d = decide({
    queueEntries: [{ state: 'QUEUED', pullRequest: { number: 5, title: 'PR 5' } }],
    openPrs: [pr(5, { isInMergeQueue: true }), pr(3, { autoMergeRequest: ARMED })],
  });
  assert.deepEqual(d.blockers.map((b) => b.number), [3, 5]);
});

test('force cuts anyway, still naming what will miss the promotion', () => {
  const d = decide({ openPrs: [pr(11, { autoMergeRequest: ARMED })], force: true });
  assert.equal(d.proceed, true);
  assert.equal(d.fail, false);
  assert.match(d.message, /#11/);
});

test('a scheduled cut is skipped, not failed', () => {
  const d = decide({ openPrs: [pr(11, { autoMergeRequest: ARMED })], event: 'schedule' });
  assert.equal(d.proceed, false);
  assert.equal(d.fail, false);
  assert.match(d.message, /Skipping/);
});

test('release-cut.yml runs the gate first and the cut depends on its output', () => {
  const wf = readFileSync(new URL('../../.github/workflows/release-cut.yml', import.meta.url), 'utf8');
  const cutJob = wf.slice(wf.indexOf('\n  cut:'));
  assert.match(cutJob, /\n {4}needs: gate\n/);
  assert.match(cutJob, /\n {4}if: needs\.gate\.outputs\.proceed == 'true'\n/);
  assert.match(wf, /uses: GarrettMakesItLLC\/ci\/actions\/release-cut-gate@v1/);
  assert.match(wf, /\n {6}force:\n {8}description:/);
  assert.match(wf, /\n {6}gate:\n {8}description:/);
});

// A token without `checks`/`statuses` cannot read rollups. The workflow asks for
// neither, because a reusable workflow that adds a permission fails every caller
// whose ceiling lacks it at startup.
test('an armed PR whose rollup is unreadable is not assumed to be landing', () => {
  assert.equal(decide({ openPrs: [pr(11, { autoMergeRequest: ARMED, rollup: 'UNREADABLE' })] }).proceed, true);
});

test('a queued PR still blocks when its rollup is unreadable', () => {
  const d = decide({ openPrs: [pr(12, { isInMergeQueue: true, rollup: 'UNREADABLE' })] });
  assert.equal(d.fail, true);
  assert.deepEqual(d.blockers.map((b) => b.number), [12]);
});

test('rollupForbidden reads a FORBIDDEN error on the rollup path, and nothing else', () => {
  const forbidden = { type: 'FORBIDDEN', path: ['repository', 'pullRequests', 'nodes', 0, 'commits', 'nodes', 0, 'commit', 'statusCheckRollup'], message: 'Resource not accessible by integration' };
  assert.equal(rollupForbidden([forbidden]), true);
  assert.equal(rollupForbidden([{ ...forbidden, type: undefined }]), true);
  assert.equal(rollupForbidden([{ ...forbidden, path: ['repository', 'mergeQueue'] }]), false);
  assert.equal(rollupForbidden(undefined), false);
});

test('release-cut.yml asks for no permission its callers were not already granting', () => {
  const wf = readFileSync(new URL('../../.github/workflows/release-cut.yml', import.meta.url), 'utf8');
  const live = wf.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.doesNotMatch(live, /^\s*(checks|statuses):/m);
});

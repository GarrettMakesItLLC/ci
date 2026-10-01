import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { judgeMetric, judgeNight, median } from './judge.mjs';

const cfg = {
  floors: { lcpMs: 2500, tbtMs: 200, cls: 0.1 },
  rises: { lcpMs: 1.1, tbtMs: 1.5, cls: 1.5 },
  baseline: 7,
  sustain: 3,
};
const args = (prior, tonight, over = {}) => ({ prior, tonight, floor: 2500, rise: 1.1, baseline: 7, sustain: 3, ...over });
const flat = (n, v = 2400) => Array(n).fill(v);

test('median', () => {
  assert.equal(median([]), undefined);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
});

test('a rise that holds for sustain nights fires', () => {
  assert.equal(judgeMetric(args([...flat(7), 2800, 2800], 2800)).outcome, 'regression');
});

test('one loud night is reported, never failed', () => {
  const r = judgeMetric(args(flat(9), 5000));
  assert.equal(r.outcome, 'clean');
  assert.equal(r.held, 1);
});

test('two elevated nights are not enough at sustain 3', () => {
  assert.equal(judgeMetric(args([...flat(8), 2800], 2800)).outcome, 'clean');
});

test('a big ratio under the floor does not fire', () => {
  const prior = [...flat(7, 1000), 1500, 1500];
  assert.equal(judgeMetric(args(prior, 1500)).outcome, 'clean');
});

test('over the floor but inside the rise factor does not fire', () => {
  assert.equal(judgeMetric(args(flat(9, 2600), 2600)).outcome, 'clean');
});

test('too little history is its own outcome, never clean', () => {
  assert.equal(judgeMetric(args(flat(8), 9999)).outcome, 'insufficient-history');
  assert.equal(judgeMetric(args([], 9999)).outcome, 'insufficient-history');
});

test('a gap in the window cannot be read as clean', () => {
  const prior = flat(9);
  prior[4] = undefined;
  assert.equal(judgeMetric(args(prior, 9999)).outcome, 'insufficient-history');
});

test('a regression that has filled the baseline goes quiet (step change, not level)', () => {
  assert.equal(judgeMetric(args(flat(9, 2800), 2800)).outcome, 'clean');
});

const load = (name) => {
  const dir = new URL(`../../.github/fixtures/cwv-judge/${name}/`, import.meta.url);
  return [JSON.parse(readFileSync(new URL('tonight.json', dir), 'utf8')), JSON.parse(readFileSync(new URL('history.json', dir), 'utf8')).nights];
};

test('fixtures: regression fires on the route over its floor only', () => {
  const [tonight, history] = load('regression');
  const r = judgeNight(tonight, history, cfg);
  assert.equal(r.verdict, 'regression');
  assert.deepEqual(r.regressions.map((x) => x.route), ['/']);
});

test('fixtures: single-night spike and under-floor rise are clean', () => {
  for (const name of ['single-night-spike', 'under-floor']) {
    const [tonight, history] = load(name);
    assert.equal(judgeNight(tonight, history, cfg).verdict, 'clean', name);
  }
});

test('fixtures: cold start passes open and says so', () => {
  const [tonight, history] = load('cold-start');
  assert.equal(judgeNight(tonight, history, cfg).verdict, 'insufficient-history');
});

test('tonight is excluded from its own history, so a same-day rerun does not judge itself', () => {
  const [tonight, history] = load('regression');
  const r = judgeNight(tonight, [...history, tonight], cfg);
  assert.equal(r.verdict, 'regression');
  assert.equal(r.nights, history.length);
});

test('a night with no measured route is unjudged, not clean', () => {
  const r = judgeNight({ date: '2026-10-01', routes: { '/': { error: 'boom' } } }, [], cfg);
  assert.equal(r.verdict, 'unjudged');
});

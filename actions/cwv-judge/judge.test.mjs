import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  fetchBranchHistory,
  judgeMetric,
  judgeNight,
  median,
  nightFromRecord,
  overFloorAnnotation,
  parseAllowances,
  publishToBranch,
  readHistoryDir,
} from './judge.mjs';

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

// --- route allowances -------------------------------------------------------------------------

const allowance = (over = {}) => ({
  route: '/',
  metric: 'LCP',
  ceiling: 3000,
  reason: 'hero video poster is the LCP element; measured in the issue',
  issue: '#123',
  expires: '2026-12-31',
  ...over,
});
const withAllowances = (list, today) => ({ ...cfg, allowances: parseAllowances(JSON.stringify(list), cfg.floors, today) });

test('allowances: an empty input is no allowances', () => {
  assert.deepEqual(parseAllowances('', cfg.floors, '2026-09-10'), []);
  assert.deepEqual(parseAllowances('  ', cfg.floors, '2026-09-10'), []);
});

test('allowances: every field is required and checked', () => {
  const bad = [
    ['not json', /not JSON/],
    ['{}', /JSON array/],
    [JSON.stringify([allowance({ route: 'x' })]), /route/],
    [JSON.stringify([allowance({ metric: 'INP' })]), /metric/],
    [JSON.stringify([allowance({ ceiling: 2500 })]), /above the lcpMs floor/],
    [JSON.stringify([allowance({ ceiling: '3000' })]), /ceiling/],
    [JSON.stringify([allowance({ reason: ' ' })]), /reason/],
    [JSON.stringify([allowance({ issue: 'soon' })]), /issue/],
    [JSON.stringify([allowance({ issue: undefined })]), /issue/],
    [JSON.stringify([allowance({ expires: 'never' })]), /expires/],
    [JSON.stringify([allowance(), allowance({ metric: 'lcpMs' })]), /repeats/],
  ];
  for (const [text, re] of bad) assert.throws(() => parseAllowances(text, cfg.floors, '2026-09-10'), re, text);
  for (const issue of ['#1', 'GarrettMakesItLLC/MuscleBuddy#6188', 'https://github.com/o/r/issues/1']) {
    assert.equal(parseAllowances(JSON.stringify([allowance({ issue })]), cfg.floors, '2026-09-10').length, 1, issue);
  }
});

test('allowances: expiry is inclusive of its own date', () => {
  assert.equal(parseAllowances(JSON.stringify([allowance({ expires: '2026-09-10' })]), cfg.floors, '2026-09-10')[0].expired, false);
  assert.equal(parseAllowances(JSON.stringify([allowance({ expires: '2026-09-09' })]), cfg.floors, '2026-09-10')[0].expired, true);
});

test('allowances: an active one passes a held rise that stays under its ceiling', () => {
  const [tonight, history] = load('regression');
  assert.equal(judgeNight(tonight, history, cfg).verdict, 'regression');
  const r = judgeNight(tonight, history, withAllowances([allowance()], tonight.date));
  assert.equal(r.verdict, 'clean');
  const row = r.rows.find((x) => x.route === '/' && x.metric.key === 'lcpMs');
  assert.equal(row.floor, 3000);
  assert.equal(row.allowance.issue, '#123');
  // Inside the allowance is still outside the floor, and never silently green.
  assert.match(overFloorAnnotation(r, cfg), /\/ LCP 2800 ms \(floor 2500 ms, inside allowance 3000 ms \(#123\); clean\)/);
});

test('allowances: a held rise over the ceiling still fails — a ceiling, not an exemption', () => {
  const [tonight, history] = load('regression');
  const r = judgeNight(tonight, history, withAllowances([allowance({ ceiling: 2600 })], tonight.date));
  assert.equal(r.verdict, 'regression');
});

test('allowances: an expired one stops applying and fails the night', () => {
  const [tonight, history] = load('regression');
  const r = judgeNight(tonight, history, withAllowances([allowance({ expires: '2026-09-01' })], tonight.date));
  // No longer applied, so the held rise is judged against the floor again.
  assert.equal(r.verdict, 'regression');
  assert.equal(r.expired.length, 1);
  // With nothing else wrong, the expiry alone is the failure.
  const [cleanTonight, cleanHistory] = load('single-night-spike');
  const c = judgeNight(cleanTonight, cleanHistory, withAllowances([allowance({ expires: '2026-09-01' })], cleanTonight.date));
  assert.equal(c.verdict, 'expired-allowance');
});

test('allowances: only the named route and metric are affected', () => {
  const [tonight, history] = load('regression');
  for (const other of [allowance({ metric: 'TBT', ceiling: 900 }), allowance({ route: '/small' }), allowance({ route: '/elsewhere' })]) {
    const r = judgeNight(tonight, history, withAllowances([other], tonight.date));
    assert.equal(r.verdict, 'regression', JSON.stringify(other));
    assert.deepEqual(r.regressions.map((x) => `${x.route} ${x.metric.key}`), ['/ lcpMs']);
  }
  const r = judgeNight(tonight, history, withAllowances([allowance({ route: '/elsewhere' })], tonight.date));
  assert.deepEqual(r.unusedAllowances.map((a) => a.route), ['/elsewhere']);
});

// --- over-floor annotation --------------------------------------------------------------------

test('over-floor: nothing over its floor carries no annotation', () => {
  const [tonight, history] = load('under-floor');
  assert.equal(overFloorAnnotation(judgeNight(tonight, history, cfg), cfg), undefined);
});

test('over-floor: a loud night the gate cleared is named, as not a regression', () => {
  const [tonight, history] = load('single-night-spike');
  const a = overFloorAnnotation(judgeNight(tonight, history, cfg), cfg);
  assert.match(a, /^::warning title=Core Web Vitals over the floor, not a regression::/);
  assert.match(a, /\/ LCP/);
});

test('over-floor: an over-floor value with too little history reads NOT judged, never cleared', () => {
  const [tonight, history] = load('cold-start');
  const hot = { ...tonight, routes: { '/': { lcpMs: 4000, tbtMs: 10, cls: 0 } } };
  const a = overFloorAnnotation(judgeNight(hot, history, cfg), cfg);
  assert.match(a, /NOT judged/);
  assert.match(a, /unjudged, not cleared/);
});

test('over-floor: a regression is an error, not also a warning', () => {
  const [tonight, history] = load('regression');
  assert.equal(overFloorAnnotation(judgeNight(tonight, history, cfg), cfg), undefined);
});

// --- ledger records and the branch store ------------------------------------------------------

test('nightFromRecord: this judge\'s own night record', () => {
  assert.deepEqual(nightFromRecord('2026-09-01', { date: '2026-09-01', routes: { '/': { lcpMs: 1, tbtMs: 2, cls: 0, runs: 5 } } }), {
    date: '2026-09-01',
    routes: { '/': { lcpMs: 1, tbtMs: 2, cls: 0 } },
  });
});

test('nightFromRecord: a { measurements } ledger record, gaps kept as gaps', () => {
  const night = nightFromRecord('2026-09-02', {
    benchmarkIndex: 2500,
    measurements: [
      { route: '/', lcpMs: 2400, tbtMs: 150, cls: 0.01 },
      { route: '/pricing', lcpMs: 2000 },
      { route: '/broken', error: 'NO_FCP' },
      { route: 'not-a-path', lcpMs: 1 },
    ],
  });
  assert.deepEqual(night, { date: '2026-09-02', routes: { '/': { lcpMs: 2400, tbtMs: 150, cls: 0.01 }, '/pricing': { lcpMs: 2000 } } });
});

test('nightFromRecord: the ledger key wins over a date inside the record; an empty record is not a night', () => {
  assert.equal(nightFromRecord('2026-09-03', { date: '1999-01-01', routes: { '/': { lcpMs: 1 } } }).date, '2026-09-03');
  assert.equal(nightFromRecord('2026-09-03', { measurements: [{ route: '/', error: 'x' }] }), undefined);
  assert.equal(nightFromRecord('2026-09-03', null), undefined);
  assert.equal(nightFromRecord('yesterday', { routes: { '/': { lcpMs: 1 } } }), undefined);
});

test('readHistoryDir: history.json plus ledger files, a ledger file winning its date, bad files skipped aloud', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cwv-ledger-'));
  writeFileSync(join(dir, 'history.json'), JSON.stringify({ nights: [{ date: '2026-09-01', routes: { '/': { lcpMs: 1 } } }, { date: '2026-09-02', routes: { '/': { lcpMs: 2 } } }] }));
  writeFileSync(join(dir, '2026-09-02.json'), JSON.stringify({ measurements: [{ route: '/', lcpMs: 22 }] }));
  writeFileSync(join(dir, '2026-09-03.json'), JSON.stringify({ measurements: [{ route: '/', lcpMs: 3 }] }));
  writeFileSync(join(dir, '2026-09-04.json'), '{not json');
  writeFileSync(join(dir, '2026-09-05.json'), JSON.stringify({ measurements: [] }));
  writeFileSync(join(dir, 'notes.json'), '{}');
  const warnings = [];
  const nights = readHistoryDir(dir, (m) => warnings.push(m));
  assert.deepEqual(nights.map((n) => [n.date, n.routes['/'].lcpMs]), [['2026-09-01', 1], ['2026-09-02', 22], ['2026-09-03', 3]]);
  assert.equal(warnings.length, 2);
  assert.deepEqual(readHistoryDir(join(dir, 'absent')), []);
});

test('readHistoryDir: an imported { measurements } ledger feeds the gate like native history', () => {
  const [tonight, history] = load('regression');
  const dir = mkdtempSync(join(tmpdir(), 'cwv-import-'));
  for (const n of history) {
    writeFileSync(join(dir, `${n.date}.json`), JSON.stringify({ measurements: Object.entries(n.routes).map(([route, m]) => ({ route, ...m })) }));
  }
  assert.equal(judgeNight(tonight, readHistoryDir(dir), cfg).verdict, 'regression');
});

const ghError = (stderr) => Object.assign(new Error('gh failed'), { stderr });

test('branch store: a missing branch or directory is the cold start', () => {
  const out = mkdtempSync(join(tmpdir(), 'cwv-branch-'));
  const listing = fetchBranchHistory({ repo: 'o/r', branch: 'evidence', path: 'perf/cwv', outDir: out, gh: () => { throw ghError('gh: Not Found (HTTP 404)'); } });
  assert.equal(listing.size, 0);
});

test('branch store: any other failure stops the lane instead of reading as zero nights', () => {
  const out = mkdtempSync(join(tmpdir(), 'cwv-branch-'));
  assert.throws(
    () => fetchBranchHistory({ repo: 'o/r', branch: 'evidence', path: 'perf/cwv', outDir: out, gh: () => { throw ghError('gh: Bad credentials (HTTP 401)'); } }),
    /could not list perf\/cwv\/ on evidence: .*401/,
  );
});

test('branch store: fetches the newest night files and remembers their shas', () => {
  const out = mkdtempSync(join(tmpdir(), 'cwv-branch-'));
  // 31 nights on the branch: one more than HISTORY_CAP, so the oldest must be left behind.
  const names = Array.from({ length: 31 }, (_, i) => `2026-08-${String(i + 1).padStart(2, '0')}.json`);
  const calls = [];
  const gh = (args) => {
    calls.push(args.join(' '));
    if (!args.includes('Accept: application/vnd.github.raw')) {
      return JSON.stringify([...names.map((name) => ({ type: 'file', name, sha: `sha-${name}` })), { type: 'file', name: 'README.md', sha: 'x' }, { type: 'dir', name: '2026-09-01.json', sha: 'y' }]);
    }
    const name = args.at(-1).split('/').at(-1).split('?')[0];
    return JSON.stringify({ measurements: [{ route: '/', lcpMs: Number(name.slice(8, 10)) }] });
  };
  const listing = fetchBranchHistory({ repo: 'o/r', branch: 'compliance-evidence', path: 'perf/lighthouse', outDir: out, gh });
  assert.equal(listing.get('2026-08-31.json'), 'sha-2026-08-31.json');
  assert.equal(listing.has('README.md'), false);
  const fetched = readdirSync(out).sort();
  assert.equal(fetched.length, 30);
  assert.equal(fetched[0], '2026-08-02.json');
  assert.ok(calls[0].includes('repos/o/r/contents/perf/lighthouse?ref=compliance-evidence'));
  assert.equal(readHistoryDir(out).length, 30);
});

test('branch store: publish writes <path>/<date>.json, replacing a same-date record by sha', () => {
  const night = { date: '2026-09-10', routes: { '/': { lcpMs: 2000, tbtMs: 10, cls: 0 } } };
  const sent = [];
  const gh = (args, input) => sent.push({ args, body: JSON.parse(input) });
  publishToBranch({ repo: 'o/r', branch: 'evidence', path: 'perf/cwv', night, existing: new Map(), gh });
  publishToBranch({ repo: 'o/r', branch: 'evidence', path: 'perf/cwv', night, existing: new Map([['2026-09-10.json', 'abc']]), gh });
  assert.deepEqual(sent[0].args, ['api', '-X', 'PUT', 'repos/o/r/contents/perf/cwv/2026-09-10.json', '--input', '-']);
  assert.equal(sent[0].body.branch, 'evidence');
  assert.equal(sent[0].body.sha, undefined);
  assert.equal(sent[1].body.sha, 'abc');
  assert.deepEqual(JSON.parse(Buffer.from(sent[0].body.content, 'base64').toString()), night);
});

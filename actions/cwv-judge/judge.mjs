// The multi-night persistence gate for Core Web Vitals.
//
// A lab run on a shared runner is noisy: one unchanged build can land on both sides of a threshold
// on two nights. That noise does not HOLD — a slow runner is drawn for a night, a regression is in
// the build every night until fixed. So no single night gates; a metric fails only when it has been
// elevated for `sustain` consecutive nights, tonight included.
//
// A night is elevated for a metric when it is BOTH over the absolute floor AND over `rise` x the
// median of the `baseline` nights before it. Without the ratio the gate is a coin flip around the
// floor; without the floor a 15 ms -> 40 ms TBT "regression" fails a route nobody would call slow.
//
// Too little history is its own outcome (`insufficient-history`), never `clean`: a gate that read
// nothing must not look like a gate that read a week and found nothing.
//
// It detects a step change, not an absolute level: a regression that has sat in the baseline for
// `baseline` nights goes quiet. The per-night table still reports the level every night.
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

/** Nights kept in the history artifact. Comfortably above what the gate reads. */
export const HISTORY_CAP = 30;

export const METRICS = [
  { key: 'lcpMs', label: 'LCP', unit: 'ms' },
  { key: 'tbtMs', label: 'TBT', unit: 'ms' },
  { key: 'cls', label: 'CLS', unit: '' },
];

export function median(values) {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Judge one metric on one route.
 *
 * @param {object} p
 * @param {(number|undefined)[]} p.prior  prior nights' values, oldest first (undefined = no number that night)
 * @param {number} p.tonight
 * @param {number} p.floor
 * @param {number} p.rise
 * @param {number} p.baseline
 * @param {number} p.sustain
 */
export function judgeMetric({ prior, tonight, floor, rise, baseline, sustain }) {
  const required = baseline + sustain - 1;
  const series = [...prior, tonight];
  // Every night the gate reads must carry a number, or the answer is "cannot judge".
  const window = series.slice(-(required + 1));
  if (window.length < required + 1 || window.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return { outcome: 'insufficient-history', required, have: prior.filter((v) => typeof v === 'number').length };
  }
  const elevatedAt = (i) => {
    const base = median(window.slice(i - baseline, i));
    return { base, elevated: window[i] > floor && window[i] > rise * base };
  };
  let held = 0;
  let baseTonight;
  for (let k = 0; k < sustain; k += 1) {
    const { base, elevated } = elevatedAt(window.length - 1 - k);
    if (k === 0) baseTonight = base;
    if (!elevated) break;
    held += 1;
  }
  const detail = { baseline: baseTonight, ratio: baseTonight > 0 ? tonight / baseTonight : Infinity, held };
  return { outcome: held === sustain ? 'regression' : 'clean', ...detail };
}

/**
 * Judge a night against its history.
 *
 * @param {{date:string, routes:Record<string,object>}} tonight
 * @param {{date:string, routes:Record<string,object>}[]} history  prior nights (any order; tonight's date excluded)
 * @param {object} cfg  { floors:{lcpMs,tbtMs,cls}, rises:{...}, baseline, sustain }
 */
export function judgeNight(tonight, history, cfg) {
  const prior = history
    .filter((n) => n.date < tonight.date)
    .sort((a, b) => (a.date < b.date ? -1 : 1))
    .slice(-HISTORY_CAP);
  const rows = [];
  const unmeasured = [];
  for (const [route, m] of Object.entries(tonight.routes)) {
    if (typeof m.lcpMs !== 'number') {
      unmeasured.push({ route, error: m.error ?? 'no measurement' });
      continue;
    }
    for (const metric of METRICS) {
      const verdict = judgeMetric({
        prior: prior.map((n) => n.routes?.[route]?.[metric.key]),
        tonight: m[metric.key],
        floor: cfg.floors[metric.key],
        rise: cfg.rises[metric.key],
        baseline: cfg.baseline,
        sustain: cfg.sustain,
      });
      rows.push({ route, metric, value: m[metric.key], ...verdict });
    }
  }
  const regressions = rows.filter((r) => r.outcome === 'regression');
  const insufficient = rows.filter((r) => r.outcome === 'insufficient-history');
  let verdict;
  if (rows.length === 0) verdict = 'unjudged';
  else if (regressions.length > 0) verdict = 'regression';
  else if (insufficient.length > 0) verdict = 'insufficient-history';
  else verdict = 'clean';
  return { verdict, rows, regressions, insufficient, unmeasured, nights: prior.length };
}

const fmt = (metric, v) => (metric.key === 'cls' ? v.toFixed(3) : `${Math.round(v)} ${metric.unit}`);

export function renderReport(result, tonight, cfg) {
  const lines = [`### Core Web Vitals — ${tonight.date}`, ''];
  lines.push(`Verdict: **${result.verdict}** (${result.nights} prior night(s) of history; gate reads ${cfg.baseline + cfg.sustain - 1}).`, '');
  lines.push('Lab numbers from a CI runner under simulated throttling: for trend and regression, not comparable to field data or PageSpeed Insights.', '');
  lines.push('| route | metric | tonight | baseline | ratio | held | outcome |', '| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of result.rows) {
    const base = r.baseline === undefined ? '—' : fmt(r.metric, r.baseline);
    const ratio = r.ratio === undefined ? '—' : `${r.ratio.toFixed(2)}x`;
    lines.push(`| \`${r.route}\` | ${r.metric.label} | ${fmt(r.metric, r.value)} | ${base} | ${ratio} | ${r.held ?? '—'}/${cfg.sustain} | ${r.outcome} |`);
  }
  for (const u of result.unmeasured) lines.push(`| \`${u.route}\` | — | UNMEASURED | — | — | — | ${u.error} |`);
  lines.push('');
  if (result.verdict === 'regression') {
    lines.push(`A regression held for ${cfg.sustain} consecutive night(s): over the floor and over ${METRICS.map((m) => `${cfg.rises[m.key]}x (${m.label})`).join(', ')} the ${cfg.baseline}-night median.`);
  } else if (result.verdict === 'insufficient-history') {
    lines.push(`NOT JUDGED: fewer than ${cfg.baseline + cfg.sustain - 1} prior nights carry numbers for some route, so the gate cannot tell a regression from noise yet. It passes open and says so.`);
  } else if (result.verdict === 'unjudged') {
    lines.push('NOT JUDGED: no route was measured, so nothing about the vitals was assessed. This is a rig failure, not a finding.');
  }
  return `${lines.join('\n')}\n`;
}

/** Download the newest non-expired history artifact for this ledger from this ref; undefined on a cold start. */
function fetchHistory({ repo, name, ref, workDir }) {
  const gh = (...args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const listing = JSON.parse(gh('api', `repos/${repo}/actions/artifacts?name=${encodeURIComponent(name)}&per_page=100`));
  const found = listing.artifacts.filter((a) => !a.expired && a.workflow_run?.head_branch === ref);
  if (found.length === 0) return [];
  found.sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
  const zip = join(workDir, 'history.zip');
  execFileSync('sh', ['-c', `gh api repos/${repo}/actions/artifacts/${found[0].id}/zip > "${zip}"`], { stdio: 'inherit' });
  const parsed = JSON.parse(execFileSync('unzip', ['-p', zip, 'history.json'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  return parsed.nights ?? [];
}

const num = (name, fallback) => {
  const raw = process.env[name];
  const v = raw === undefined || raw === '' ? fallback : Number(raw);
  if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number, got "${raw}"`);
  return v;
};

function main() {
  const tonightFile = process.env.CWV_MEASUREMENTS_FILE ?? '';
  if (!tonightFile || !existsSync(tonightFile)) {
    console.log('::error title=cwv-judge::no measurements file — the measure step did not produce a night, so nothing was judged');
    finish('unjudged', '', 1);
    return;
  }
  const tonight = JSON.parse(readFileSync(tonightFile, 'utf8'));
  const cfg = {
    floors: { lcpMs: num('CWV_LCP_FLOOR_MS', 2500), tbtMs: num('CWV_TBT_FLOOR_MS', 200), cls: num('CWV_CLS_FLOOR', 0.1) },
    rises: { lcpMs: num('CWV_LCP_RISE', 1.1), tbtMs: num('CWV_TBT_RISE', 1.5), cls: num('CWV_CLS_RISE', 1.5) },
    baseline: Math.trunc(num('CWV_BASELINE_NIGHTS', 7)),
    sustain: Math.trunc(num('CWV_SUSTAIN_NIGHTS', 3)),
  };
  const workDir = mkdtempSync(join(tmpdir(), 'cwv-'));
  let history;
  const historyDir = process.env.CWV_HISTORY_DIR ?? '';
  if (historyDir !== '') {
    const f = join(historyDir, 'history.json');
    history = existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')).nights ?? [] : [];
  } else {
    // An unreadable ledger and an empty one both yield zero nights, and only this step still knows
    // which happened — so a fetch failure stops the lane instead of degrading to a cold start.
    history = fetchHistory({
      repo: process.env.GITHUB_REPOSITORY ?? '',
      name: process.env.CWV_HISTORY_ARTIFACT ?? 'cwv-history',
      ref: process.env.GITHUB_REF_NAME ?? '',
      workDir,
    });
  }

  const result = judgeNight(tonight, history, cfg);
  const report = renderReport(result, tonight, cfg);
  console.log(report);
  for (const r of result.regressions) {
    console.log(`::error title=Core Web Vitals regression::${r.route} ${r.metric.label} ${fmt(r.metric, r.value)} is ${r.ratio.toFixed(2)}x its ${cfg.baseline}-night median and has held ${cfg.sustain} nights`);
  }
  for (const u of result.unmeasured) console.log(`::warning title=Route unmeasured::${u.route}: ${u.error}`);
  if (result.verdict === 'insufficient-history') console.log('::warning title=Core Web Vitals not judged::too little history to judge persistence');

  // Tonight joins the ledger whatever the verdict: a ledger of only the good nights proves nothing was slow.
  const nights = [...history.filter((n) => n.date !== tonight.date), tonight].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-HISTORY_CAP);
  const outDir = process.env.CWV_HISTORY_OUT_DIR || join(process.env.RUNNER_TEMP || tmpdir(), 'cwv-history-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'history.json'), `${JSON.stringify({ nights }, null, 2)}\n`);
  writeFileSync(join(outDir, 'report.md'), report);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
  finish(result.verdict, outDir, result.verdict === 'regression' || result.verdict === 'unjudged' ? 1 : 0);
}

function finish(verdict, outDir, code) {
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `verdict=${verdict}\nhistory-dir=${outDir}\n`);
  }
  console.log(`verdict=${verdict}`);
  process.exit(code);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    main();
  } catch (e) {
    console.log(`::error title=cwv-judge::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  }
}

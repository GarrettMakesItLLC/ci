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
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Nights kept in the history artifact. Comfortably above what the gate reads. */
export const HISTORY_CAP = 30;

export const METRICS = [
  { key: 'lcpMs', label: 'LCP', unit: 'ms' },
  { key: 'tbtMs', label: 'TBT', unit: 'ms' },
  { key: 'cls', label: 'CLS', unit: '' },
];

const METRIC_ALIASES = { lcp: 'lcpMs', lcpms: 'lcpMs', tbt: 'tbtMs', tbtms: 'tbtMs', cls: 'cls' };
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse and validate the `route-allowances` input: a JSON array of
 * `{ route, metric, ceiling, reason, issue, expires }`.
 *
 * An allowance holds one metric on one route to `ceiling` instead of the floor, because the floor
 * is measured to be the wrong number for that route on this rig. It is only honest while it can be
 * found and questioned, so every field is required: the issue that measured it, the argument, and a
 * date after which it stops applying and FAILS the lane until it is renewed or removed. An allowance
 * nobody revisits is how a regression gate becomes an exemption list.
 *
 * @param {string} text
 * @param {Record<string, number>} floors  the default floor per metric key
 * @param {string} today  YYYY-MM-DD; an allowance is expired once `expires` is before it
 */
export function parseAllowances(text, floors, today) {
  if (text === undefined || text.trim() === '') return [];
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`route-allowances is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Array.isArray(raw)) throw new Error('route-allowances must be a JSON array');
  const seen = new Set();
  return raw.map((a, i) => {
    const where = `route-allowances[${i}]`;
    if (typeof a !== 'object' || a === null) throw new Error(`${where} must be an object`);
    const { route, metric, ceiling, reason, issue, expires } = a;
    if (typeof route !== 'string' || !route.startsWith('/')) throw new Error(`${where}.route must be a path starting with "/"`);
    const key = typeof metric === 'string' ? METRIC_ALIASES[metric.toLowerCase()] : undefined;
    if (key === undefined) throw new Error(`${where}.metric must be one of LCP, TBT, CLS`);
    if (typeof ceiling !== 'number' || !Number.isFinite(ceiling) || ceiling <= floors[key]) {
      throw new Error(`${where}.ceiling must be a number above the ${key} floor (${floors[key]}) — an allowance at or under the floor allows nothing`);
    }
    if (typeof reason !== 'string' || reason.trim() === '') throw new Error(`${where}.reason must say why the floor is the wrong number for this route`);
    if (typeof issue !== 'string' || !/(^#\d+$)|(^[\w.-]+\/[\w.-]+#\d+$)|(^https:\/\/\S+$)/.test(issue)) {
      throw new Error(`${where}.issue must name the issue that measured it (#123, owner/repo#123 or a URL)`);
    }
    if (typeof expires !== 'string' || !DATE.test(expires) || Number.isNaN(Date.parse(expires))) {
      throw new Error(`${where}.expires must be a YYYY-MM-DD date`);
    }
    const id = `${route} ${key}`;
    if (seen.has(id)) throw new Error(`${where} repeats an allowance for ${id}`);
    seen.add(id);
    return { route, metric: key, ceiling, reason, issue, expires, expired: expires < today };
  });
}

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
  const allowances = cfg.allowances ?? [];
  const rows = [];
  const unmeasured = [];
  for (const [route, m] of Object.entries(tonight.routes)) {
    if (typeof m.lcpMs !== 'number') {
      unmeasured.push({ route, error: m.error ?? 'no measurement' });
      continue;
    }
    for (const metric of METRICS) {
      // An expired allowance no longer applies: the route is judged against the floor again, and
      // the expiry itself fails the night below.
      const allowance = allowances.find((a) => a.route === route && a.metric === metric.key && !a.expired);
      const floor = allowance?.ceiling ?? cfg.floors[metric.key];
      const verdict = judgeMetric({
        prior: prior.map((n) => n.routes?.[route]?.[metric.key]),
        tonight: m[metric.key],
        floor,
        rise: cfg.rises[metric.key],
        baseline: cfg.baseline,
        sustain: cfg.sustain,
      });
      rows.push({ route, metric, value: m[metric.key], floor, allowance, ...verdict });
    }
  }
  const regressions = rows.filter((r) => r.outcome === 'regression');
  const insufficient = rows.filter((r) => r.outcome === 'insufficient-history');
  const expired = allowances.filter((a) => a.expired);
  const unusedAllowances = allowances.filter((a) => !a.expired && !rows.some((r) => r.allowance === a));
  let verdict;
  if (rows.length === 0) verdict = 'unjudged';
  else if (regressions.length > 0) verdict = 'regression';
  else if (expired.length > 0) verdict = 'expired-allowance';
  else if (insufficient.length > 0) verdict = 'insufficient-history';
  else verdict = 'clean';
  return { verdict, rows, regressions, insufficient, unmeasured, expired, unusedAllowances, nights: prior.length };
}

/**
 * Measurements over their floor that did NOT fail the night — reported, never gated.
 *
 * A green lane is read by nobody, so a night where a route sat over its floor must not look like
 * one where every route was inside it. Two different states are folded into this list and must
 * never read the same: the gate looked and found no rise that held (`clean`), or it had too little
 * history to look (`insufficient-history`). The second is an absence, not a pass.
 */
export function overFloorRows(result) {
  return result.rows.filter((r) => r.value > r.floor && r.outcome !== 'regression');
}

/** The `::warning` a night with over-floor measurements must carry, or undefined. */
export function overFloorAnnotation(result, cfg) {
  const over = overFloorRows(result);
  if (over.length === 0) return undefined;
  const unjudged = over.filter((r) => r.outcome !== 'clean');
  const title = unjudged.length > 0 ? 'Core Web Vitals over the floor, NOT judged' : 'Core Web Vitals over the floor, not a regression';
  const list = over.map((r) => `${r.route} ${r.metric.label} ${fmt(r.metric, r.value)} (floor ${fmt(r.metric, r.floor)}${r.allowance ? ', allowance' : ''}; ${r.outcome})`).join('; ');
  const tail =
    unjudged.length > 0
      ? ` ${unjudged.length} of them were not judged at all — fewer than ${cfg.baseline + cfg.sustain - 1} prior nights carry numbers — which is unjudged, not cleared.`
      : '';
  return `::warning title=${title}::${over.length} measurement(s) over their floor: ${list}. The gate fails only a rise that holds ${cfg.sustain} consecutive nights over the ${cfg.baseline}-night median.${tail}`;
}

const fmt = (metric, v) => (metric.key === 'cls' ? v.toFixed(3) : `${Math.round(v)} ${metric.unit}`);

export function renderReport(result, tonight, cfg) {
  const lines = [`### Core Web Vitals — ${tonight.date}`, ''];
  lines.push(`Verdict: **${result.verdict}** (${result.nights} prior night(s) of history; gate reads ${cfg.baseline + cfg.sustain - 1}).`, '');
  lines.push('Lab numbers from a CI runner under simulated throttling: for trend and regression, not comparable to field data or PageSpeed Insights.', '');
  lines.push('| route | metric | tonight | floor | baseline | ratio | held | outcome |', '| --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of result.rows) {
    const base = r.baseline === undefined ? '—' : fmt(r.metric, r.baseline);
    const ratio = r.ratio === undefined ? '—' : `${r.ratio.toFixed(2)}x`;
    const floor = `${fmt(r.metric, r.floor)}${r.allowance ? ` (allowance ${r.allowance.issue}, until ${r.allowance.expires})` : ''}`;
    const over = r.value > r.floor && r.outcome !== 'regression' ? ' †' : '';
    lines.push(`| \`${r.route}\` | ${r.metric.label} | ${fmt(r.metric, r.value)}${over} | ${floor} | ${base} | ${ratio} | ${r.held ?? '—'}/${cfg.sustain} | ${r.outcome} |`);
  }
  for (const u of result.unmeasured) lines.push(`| \`${u.route}\` | — | UNMEASURED | — | — | — | — | ${u.error} |`);
  lines.push('');
  if (overFloorRows(result).length > 0) lines.push('† over its floor tonight and not a regression: reported, not gated.', '');
  for (const a of result.expired ?? []) {
    lines.push(`EXPIRED ALLOWANCE: \`${a.route}\` ${a.metric} ceiling ${a.ceiling} (${a.issue}) expired ${a.expires}. It no longer applies and fails the lane until it is renewed with a new date or removed. Its reason: ${a.reason}`, '');
  }
  for (const a of result.unusedAllowances ?? []) {
    lines.push(`Unused allowance: \`${a.route}\` ${a.metric} (${a.issue}) names a route not measured tonight.`, '');
  }
  if (result.verdict === 'regression') {
    lines.push(`A regression held for ${cfg.sustain} consecutive night(s): over the floor and over ${METRICS.map((m) => `${cfg.rises[m.key]}x (${m.label})`).join(', ')} the ${cfg.baseline}-night median.`);
  } else if (result.verdict === 'insufficient-history') {
    lines.push(`NOT JUDGED: fewer than ${cfg.baseline + cfg.sustain - 1} prior nights carry numbers for some route, so the gate cannot tell a regression from noise yet. It passes open and says so.`);
  } else if (result.verdict === 'expired-allowance') {
    lines.push('No regression held, but a route allowance has expired. Renew it (a new `expires`, with the measurement that justifies it) or delete it.');
  } else if (result.verdict === 'unjudged') {
    lines.push('NOT JUDGED: no route was measured, so nothing about the vitals was assessed. This is a rig failure, not a finding.');
  }
  return `${lines.join('\n')}\n`;
}

/**
 * One night from one ledger record, or undefined when it carries no usable number.
 *
 * Two record shapes are read, so a lane that already keeps a ledger keeps its baseline when it
 * moves onto this judge:
 *   - this judge's own night record, `{ date, routes: { "/x": { lcpMs, tbtMs, cls } } }`
 *     (what `cwv-measure` writes);
 *   - a per-route list, `{ measurements: [{ route, lcpMs, tbtMs, cls, error? }] }` — the shape
 *     MuscleBuddy's `perf/lighthouse/<date>.json` ledger holds.
 * `date` is the ledger's key (the file name) and wins over any date inside the record. A route
 * with no number is a gap, never a zero, and a record with no number at all is not a night: an
 * empty night is indistinguishable from one on which every route was fast.
 */
export function nightFromRecord(date, record) {
  if (!DATE.test(date ?? '') || typeof record !== 'object' || record === null) return undefined;
  const entries = Array.isArray(record.measurements)
    ? record.measurements.map((m) => [m?.route, m])
    : typeof record.routes === 'object' && record.routes !== null
      ? Object.entries(record.routes)
      : [];
  const routes = {};
  for (const [route, m] of entries) {
    if (typeof route !== 'string' || !route.startsWith('/') || typeof m !== 'object' || m === null) continue;
    const kept = {};
    for (const { key } of METRICS) {
      if (typeof m[key] === 'number' && Number.isFinite(m[key]) && m[key] >= 0) kept[key] = m[key];
    }
    if (Object.keys(kept).length > 0) routes[route] = kept;
  }
  return Object.keys(routes).length === 0 ? undefined : { date, routes };
}

const LEDGER_FILE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Every night a directory holds: `history.json` (the artifact store's `{ nights }`) and any
 * per-night `<YYYY-MM-DD>.json` ledger files beside it. A ledger file wins over `history.json` for
 * the same date. A file that does not parse is skipped with a warning, never silently — a ledger
 * quietly losing records is a gate quietly turning itself off.
 */
export function readHistoryDir(dir, warn = (m) => console.log(`::warning title=cwv-judge history::${m}`)) {
  const byDate = new Map();
  const historyFile = join(dir, 'history.json');
  if (existsSync(historyFile)) {
    for (const n of JSON.parse(readFileSync(historyFile, 'utf8')).nights ?? []) {
      const night = nightFromRecord(n?.date, n);
      if (night) byDate.set(night.date, night);
    }
  }
  const names = existsSync(dir) ? readdirSync(dir).sort() : [];
  for (const name of names) {
    const date = LEDGER_FILE.exec(name)?.[1];
    if (date === undefined) continue;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    } catch (e) {
      warn(`${name} did not parse and is not counted as a night: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
    const night = nightFromRecord(date, parsed);
    if (night === undefined) {
      warn(`${name} carries no usable measurement and is not counted as a night`);
      continue;
    }
    byDate.set(date, night);
  }
  return [...byDate.values()].sort((a, b) => (a.date < b.date ? -1 : 1));
}

/** Run `gh`, returning stdout; a failure carries gh's stderr so the caller can tell a 404 apart. */
function runGh(args, input) {
  return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, input, stdio: ['pipe', 'pipe', 'pipe'] });
}

const isNotFound = (e) => /HTTP 404|Not Found/.test(`${e?.stderr ?? ''}${e?.message ?? ''}`);

/**
 * The branch-backed store: one `<path>/<YYYY-MM-DD>.json` per night on `branch`, which outlives any
 * artifact retention and doubles as an evidence ledger. Fetches the newest HISTORY_CAP night files
 * into `outDir` and returns the listing (name -> blob sha) for the publish step.
 *
 * A missing branch or directory is the cold start and yields nothing. Any other failure throws: an
 * unreadable ledger and an empty one both come back as zero nights, and only here, with the HTTP
 * status in hand, can the two be told apart.
 */
export function fetchBranchHistory({ repo, branch, path, outDir, gh = runGh }) {
  let listing;
  try {
    listing = JSON.parse(gh(['api', `repos/${repo}/contents/${path}?ref=${encodeURIComponent(branch)}`]));
  } catch (e) {
    if (isNotFound(e)) return new Map();
    throw new Error(`could not list ${path}/ on ${branch}: ${(e?.stderr || e?.message || String(e)).trim()}`);
  }
  if (!Array.isArray(listing)) throw new Error(`${path} on ${branch} is not a directory`);
  const files = listing.filter((f) => f.type === 'file' && LEDGER_FILE.test(f.name)).sort((a, b) => (a.name < b.name ? -1 : 1));
  mkdirSync(outDir, { recursive: true });
  for (const f of files.slice(-HISTORY_CAP)) {
    const body = gh(['api', '-H', 'Accept: application/vnd.github.raw', `repos/${repo}/contents/${path}/${f.name}?ref=${encodeURIComponent(branch)}`]);
    writeFileSync(join(outDir, f.name), body);
  }
  return new Map(files.map((f) => [f.name, f.sha]));
}

/**
 * Publish tonight's record to the branch store as `<path>/<date>.json`, replacing a same-date
 * record from an earlier run. Needs a token with `contents: write` on the branch.
 */
export function publishToBranch({ repo, branch, path, night, existing, gh = runGh }) {
  const name = `${night.date}.json`;
  const body = {
    message: `perf(cwv): ${night.date} night record`,
    content: Buffer.from(`${JSON.stringify(night, null, 2)}\n`).toString('base64'),
    branch,
  };
  const sha = existing.get(name);
  if (sha) body.sha = sha;
  gh(['api', '-X', 'PUT', `repos/${repo}/contents/${path}/${name}`, '--input', '-'], JSON.stringify(body));
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
  cfg.allowances = parseAllowances(process.env.CWV_ROUTE_ALLOWANCES ?? '', cfg.floors, tonight.date);
  const workDir = mkdtempSync(join(tmpdir(), 'cwv-'));
  let history;
  const historyDir = process.env.CWV_HISTORY_DIR ?? '';
  const repo = process.env.GITHUB_REPOSITORY ?? '';
  const branch = process.env.CWV_HISTORY_BRANCH ?? '';
  const branchPath = (process.env.CWV_HISTORY_PATH || 'perf/cwv').replace(/^\/+|\/+$/g, '');
  let branchListing;
  if (historyDir !== '') {
    history = readHistoryDir(historyDir);
  } else if (branch !== '') {
    const ledgerDir = join(workDir, 'ledger');
    branchListing = fetchBranchHistory({ repo, branch, path: branchPath, outDir: ledgerDir });
    history = readHistoryDir(ledgerDir);
    console.log(`Read ${history.length} night(s) from ${branch}:${branchPath}/.`);
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
  const annotation = overFloorAnnotation(result, cfg);
  if (annotation) console.log(annotation);
  for (const a of result.expired) {
    console.log(`::error title=Route allowance expired::${a.route} ${a.metric} ceiling ${a.ceiling} (${a.issue}) expired ${a.expires} — renew it with a new date or remove it`);
  }
  for (const a of result.unusedAllowances) console.log(`::warning title=Unused route allowance::${a.route} ${a.metric} (${a.issue}) names a route not measured tonight`);

  // Tonight joins the ledger whatever the verdict: a ledger of only the good nights proves nothing was slow.
  const nights = [...history.filter((n) => n.date !== tonight.date), tonight].sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-HISTORY_CAP);
  const outDir = process.env.CWV_HISTORY_OUT_DIR || join(process.env.RUNNER_TEMP || tmpdir(), 'cwv-history-out');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'history.json'), `${JSON.stringify({ nights }, null, 2)}\n`);
  let finalReport = report;
  let publishFailed = false;
  if (branchListing !== undefined) {
    try {
      publishToBranch({ repo, branch, path: branchPath, night: tonight, existing: branchListing });
      console.log(`Published ${tonight.date} to ${branch}:${branchPath}/.`);
    } catch (e) {
      publishFailed = true;
      const why = (e?.stderr || e?.message || String(e)).trim();
      console.log(`::error title=cwv-judge history::tonight was not published to ${branch}:${branchPath}/ — ${why}. The token needs contents: write on that branch, and the branch must exist.`);
      finalReport += `\nHISTORY NOT PUBLISHED: tonight could not be written to \`${branch}:${branchPath}/\` (${why}), so the next night judges without it.\n`;
    }
  }
  writeFileSync(join(outDir, 'report.md'), finalReport);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, finalReport);
  const failing = ['regression', 'unjudged', 'expired-allowance'].includes(result.verdict) || publishFailed;
  finish(result.verdict, outDir, failing ? 1 : 0);
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

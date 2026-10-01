// Measure LCP / TBT / CLS for a list of routes with a local Lighthouse and write one "night" record.
//
// Lab numbers from a shared runner are noisy, so each route is measured RUNS times and the median
// kept; the persistence gate in `cwv-judge` is what turns the nightly record into a verdict. This
// script never judges. A route that cannot be measured is recorded with `error` and no metrics —
// an absent number is not a zero.
import { launch } from 'chrome-launcher';
import lighthouse from 'lighthouse';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

export function median(values) {
  if (values.length === 0) return undefined;
  const s = [...values].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Parse the newline/comma separated route list; every route must be a path. */
export function parseRoutes(text) {
  const routes = text
    .split(/[\n,]/)
    .map((r) => r.trim())
    .filter((r) => r !== '' && !r.startsWith('#'));
  for (const r of routes) {
    if (!r.startsWith('/')) throw new Error(`route "${r}" must start with "/"`);
  }
  return [...new Set(routes)];
}

async function measureOnce(port, url, formFactor) {
  const config =
    formFactor === 'desktop'
      ? { extends: 'lighthouse:default', settings: { formFactor: 'desktop', screenEmulation: { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false }, throttling: { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 } } }
      : undefined;
  const result = await lighthouse(url, { port, output: 'json', logLevel: 'error', onlyCategories: ['performance'] }, config);
  const lhr = result?.lhr;
  if (lhr === undefined) throw new Error('Lighthouse returned no result');
  if (lhr.runtimeError !== undefined) throw new Error(`${lhr.runtimeError.code}: ${lhr.runtimeError.message}`);
  const numeric = (id) => {
    const v = lhr.audits[id]?.numericValue;
    if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`Lighthouse reported no \`${id}\``);
    return v;
  };
  return {
    lcpMs: numeric('largest-contentful-paint'),
    tbtMs: numeric('total-blocking-time'),
    cls: numeric('cumulative-layout-shift'),
  };
}

async function main() {
  const baseUrl = process.env.CWV_BASE_URL ?? '';
  const out = process.env.CWV_OUT ?? '';
  const runs = Number.parseInt(process.env.CWV_RUNS ?? '5', 10);
  const formFactor = process.env.CWV_FORM_FACTOR ?? 'mobile';
  if (!baseUrl || !out) throw new Error('CWV_BASE_URL and CWV_OUT are required');
  if (!Number.isInteger(runs) || runs < 1) throw new Error(`runs must be a positive integer, got "${process.env.CWV_RUNS}"`);
  const routes = parseRoutes(process.env.CWV_ROUTES ?? '');
  if (routes.length === 0) throw new Error('no routes to measure');

  const chrome = await launch({
    chromePath: process.env.CWV_CHROME_PATH || undefined,
    chromeFlags: ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'],
  });
  const measured = {};
  try {
    for (const route of routes) {
      const url = new URL(route, baseUrl).toString();
      const samples = [];
      let firstError;
      for (let i = 0; i < runs; i += 1) {
        try {
          samples.push(await measureOnce(chrome.port, url, formFactor));
        } catch (e) {
          firstError ??= e instanceof Error ? e.message : String(e);
        }
      }
      if (samples.length === 0) {
        measured[route] = { error: firstError ?? 'every run failed without a reason' };
        console.log(`${route}: UNMEASURED (${measured[route].error})`);
        continue;
      }
      measured[route] = {
        lcpMs: median(samples.map((s) => s.lcpMs)),
        tbtMs: median(samples.map((s) => s.tbtMs)),
        cls: median(samples.map((s) => s.cls)),
        runs: samples.length,
      };
      const m = measured[route];
      console.log(`${route}: LCP ${Math.round(m.lcpMs)} ms, TBT ${Math.round(m.tbtMs)} ms, CLS ${m.cls.toFixed(3)} (${samples.length}/${runs} runs)`);
    }
  } finally {
    await chrome.kill();
  }

  const date = process.env.CWV_DATE || new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ date, baseUrl, formFactor, runs, routes: measured }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=cwv-measure::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

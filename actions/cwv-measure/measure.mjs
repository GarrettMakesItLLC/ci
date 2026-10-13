// Measure LCP / TBT / CLS for a list of routes with a local Lighthouse and write one "night" record.
//
// Lab numbers from a shared runner are noisy, so each route is measured RUNS times and the median
// kept; the persistence gate in `cwv-judge` is what turns the nightly record into a verdict. This
// script never judges. A route that cannot be measured is recorded with `error` and no metrics —
// an absent number is not a zero.
//
// Lighthouse, chrome-launcher and playwright-core are imported where they are used, so the pure
// helpers below load (and are tested) without the action's dependencies installed.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startH2Front } from './h2-front.mjs';

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

/** `local-storage`: a JSON object of string values seeded on every document before it runs. */
export function parseLocalStorage(text) {
  if (text.trim() === '') return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch (e) {
    throw new Error(`local-storage is not JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('local-storage must be a JSON object of string values');
  }
  for (const [k, v] of Object.entries(value)) {
    if (typeof v !== 'string') throw new Error(`local-storage["${k}"] must be a string`);
  }
  return value;
}

/** `abort-url-patterns`: newline separated regular expressions; a request whose URL matches one is aborted. */
export function parseAbortPatterns(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '' && !l.startsWith('#'))
    .map((l) => new RegExp(l));
}

/**
 * Transfer size of every request that is not on the page's own origin. Unsized requests (a failed
 * or aborted one) count for nothing rather than guessing.
 */
export function thirdPartyTransfer(items, pageUrl) {
  const origin = new URL(pageUrl).origin;
  let bytes = 0;
  let requests = 0;
  for (const item of items) {
    if (typeof item?.url !== 'string' || !/^https?:/.test(item.url)) continue;
    if (new URL(item.url).origin === origin) continue;
    requests += 1;
    if (typeof item.transferSize === 'number' && Number.isFinite(item.transferSize)) bytes += item.transferSize;
  }
  return { bytes, requests };
}

/**
 * Whether a run is the state the caller asked to measure. `third-party: required` discards a run
 * that loaded nothing off-origin (a consent seed that did not take measures the denied page);
 * `none` discards one that loaded something.
 */
export function thirdPartyVerdict(mode, requests) {
  if (mode === 'required' && requests === 0) return 'the run loaded no third-party request, so the state seeded for it did not take';
  if (mode === 'none' && requests > 0) return `the run loaded ${requests} third-party request(s) where none were expected`;
  return undefined;
}

async function measureOnce(port, url, formFactor, thirdParty) {
  const { default: lighthouse } = await import('lighthouse');
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
  const details = lhr.audits['network-requests']?.details;
  const items = Array.isArray(details?.items) ? details.items : [];
  const tp = thirdPartyTransfer(items, url);
  const wrongState = thirdPartyVerdict(thirdParty, tp.requests);
  if (wrongState !== undefined) throw new Error(wrongState);
  return {
    lcpMs: numeric('largest-contentful-paint'),
    tbtMs: numeric('total-blocking-time'),
    cls: numeric('cumulative-layout-shift'),
    thirdPartyBytes: tp.bytes,
    thirdPartyRequests: tp.requests,
  };
}

/**
 * A browser the caller's page state is set up in. Lighthouse attaches to its debugging port and
 * opens its own tab, so anything that must reach that tab (an init script, a request route) has to
 * live on the browser CONTEXT, which Playwright owns and chrome-launcher cannot offer.
 *
 * `setup-module` is an ES module in the caller's checkout:
 *   export async function setup(context) {}            // once: init scripts, routes, cookies
 *   export async function prepare(context, { route, url }) {}  // per route, before measuring;
 *                                                      // return a string to report the route UNMEASURED
 */
async function launchContextRig({ chromeFlags, chromePath, setupModule, localStorage, abortPatterns, hideAutomation }) {
  const { chromium } = await import('playwright-core');
  const userDataDir = mkdtempSync(join(tmpdir(), 'cwv-measure-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    ...(chromePath ? { executablePath: chromePath } : { channel: 'chrome' }),
    headless: true,
    // Device emulation is Lighthouse's; a Playwright viewport would fight it on the tab it opens.
    viewport: null,
    // A service worker's fetches bypass the context's routes, so fixtures and aborts would not apply.
    serviceWorkers: 'block',
    args: ['--remote-debugging-port=0', ...(hideAutomation ? ['--disable-blink-features=AutomationControlled'] : []), ...chromeFlags],
  });
  if (hideAutomation || Object.keys(localStorage).length > 0) {
    await context.addInitScript(
      ({ hide, seed }) => {
        if (hide) Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false });
        try {
          for (const [k, v] of Object.entries(seed)) window.localStorage.setItem(k, v);
        } catch {
          // A storage-less document has nothing to seed.
        }
      },
      { hide: hideAutomation, seed: localStorage },
    );
  }
  if (abortPatterns.length > 0) {
    await context.route(
      (url) => abortPatterns.some((p) => p.test(url.toString())),
      (route) => route.abort(),
    );
  }
  const mod = setupModule ? await import(pathToFileURL(resolve(setupModule)).href) : {};
  if (typeof mod.setup === 'function') await mod.setup(context);
  const port = await devToolsPort(userDataDir);
  return {
    port,
    prepare: async (route, url) => (typeof mod.prepare === 'function' ? mod.prepare(context, { route, url }) : undefined),
    close: async () => {
      await context.close();
      rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** The port Chrome wrote to `DevToolsActivePort` once it was listening. */
async function devToolsPort(userDataDir) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < 100; i += 1) {
    try {
      const port = Number.parseInt(readFileSync(file, 'utf8').split('\n')[0], 10);
      if (Number.isInteger(port) && port > 0) return port;
    } catch {
      // Not written yet.
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('Chrome never wrote DevToolsActivePort, so Lighthouse has no port to attach to');
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
  const http2 = process.env.CWV_HTTP2 === 'true';

  // A front that cannot start is a rig failure and stops here, before any route is measured over a
  // transport the caller did not ask for.
  const front = http2 ? await startH2Front(baseUrl) : undefined;
  const measureOrigin = front?.origin ?? baseUrl;
  if (front) console.log(`Measuring through an HTTP/2 front at ${front.origin} over ${baseUrl}.`);
  const chromeFlags = ['--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];
  if (front) chromeFlags.push(`--ignore-certificate-errors-spki-list=${front.spkiSha256}`);
  const thirdParty = process.env.CWV_THIRD_PARTY || 'any';
  if (!['any', 'required', 'none'].includes(thirdParty)) throw new Error(`third-party must be any, required or none, got "${thirdParty}"`);
  const setupModule = process.env.CWV_SETUP_MODULE || '';
  const localStorage = parseLocalStorage(process.env.CWV_LOCAL_STORAGE ?? '');
  const abortPatterns = parseAbortPatterns(process.env.CWV_ABORT_URL_PATTERNS ?? '');
  const hideAutomation = process.env.CWV_HIDE_AUTOMATION === 'true';
  const chromePath = process.env.CWV_CHROME_PATH || undefined;
  const needsContext = setupModule !== '' || Object.keys(localStorage).length > 0 || abortPatterns.length > 0 || hideAutomation;

  let rig;
  if (needsContext) {
    rig = await launchContextRig({ chromeFlags: chromeFlags.filter((f) => f !== '--headless=new'), chromePath, setupModule, localStorage, abortPatterns, hideAutomation });
  } else {
    const { launch } = await import('chrome-launcher');
    const chrome = await launch({ chromePath, chromeFlags });
    rig = { port: chrome.port, prepare: async () => undefined, close: () => chrome.kill() };
  }
  const measured = {};
  try {
    for (const route of routes) {
      const url = new URL(route, measureOrigin).toString();
      const unready = await rig.prepare(route, url);
      if (unready !== undefined) {
        measured[route] = { error: String(unready) };
        console.log(`${route}: UNMEASURED (${measured[route].error})`);
        continue;
      }
      const samples = [];
      let firstError;
      for (let i = 0; i < runs; i += 1) {
        try {
          samples.push(await measureOnce(rig.port, url, formFactor, thirdParty));
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
        thirdPartyBytes: median(samples.map((s) => s.thirdPartyBytes)),
        thirdPartyRequests: median(samples.map((s) => s.thirdPartyRequests)),
        runs: samples.length,
      };
      const m = measured[route];
      console.log(`${route}: LCP ${Math.round(m.lcpMs)} ms, TBT ${Math.round(m.tbtMs)} ms, CLS ${m.cls.toFixed(3)}, third-party ${Math.round(m.thirdPartyBytes / 1024)} KB (${samples.length}/${runs} runs)`);
    }
  } finally {
    await rig.close();
    await front?.close();
  }

  const date = process.env.CWV_DATE || new Date().toISOString().slice(0, 10);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, `${JSON.stringify({ date, baseUrl, transport: http2 ? 'h2' : 'as-served', formFactor, runs, routes: measured }, null, 2)}\n`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`::error title=cwv-measure::${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}

#!/usr/bin/env node
/**
 * Fails when a direct dependency declared in a workspace's `package.json`
 * manifests has no row in that repo's dependency-inventory doc.
 *
 * Generalized out of platform's `scripts/check-dependency-inventory.mjs` and
 * AdventureOS's `scripts/check-dependency-inventory.mjs` (ci#61) — the same
 * doc-vs-manifest drift check, maintained twice with a 377-line diff between
 * them because every repo-specific knob (which manifests to scan, which
 * fields count, which names are workspace-internal, how a "documented" name
 * is recognized in the doc) was hardcoded instead of parameterized.
 *
 * What this script does NOT cover: AdventureOS's script also scans source
 * for `process.env` / `import.meta.env` reads and cross-checks a
 * `<!-- gmi-package-count -->` marker. Those are a separate audit bolted
 * onto the same file, not the doc-vs-manifest check this action unifies —
 * they stay in AdventureOS's own script until/unless a follow-up gives them
 * the same treatment.
 *
 * Every option below is a CLI flag so the same file runs two ways: as a
 * composite-action step (`action.yml` passes its inputs as flags) and
 * directly under `node` against a fixture pair, which is how this script's
 * own gate in `self-check.yml` proves the drift detection actually fires.
 *
 * Flags:
 *   --doc-path <path>              required. Doc to check rows/mentions against.
 *   --manifest-paths <list>        comma-separated package.json paths, relative to
 *                                   --cwd. A single `*` path segment is expanded to
 *                                   every subdirectory at that position (so
 *                                   `packages/*\/package.json` scans every package).
 *                                   Default: packages/*\/package.json
 *   --dependency-fields <list>     comma-separated manifest fields to scan.
 *                                   Default: dependencies,devDependencies,peerDependencies
 *   --workspace-prefixes <list>    comma-separated name prefixes that are
 *                                   workspace-internal and never need a doc row
 *                                   (e.g. `@gmi/,@garrettmakesitllc/`). Default: (none)
 *   --allowlist <list>             comma-separated exact dependency names that never
 *                                   need a doc row (e.g. packages with no external
 *                                   surface of their own). Default: (none)
 *   --match-mode <mode>            `table-row` (default) — the name must appear as
 *                                   the first column of a markdown table row,
 *                                   `` | `name` | ... `` — or `substring` — the name
 *                                   must appear anywhere in the doc's text.
 *   --cwd <path>                   directory manifest-paths and doc-path are
 *                                   resolved against. Default: process.cwd()
 */
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const args = {
    docPath: null,
    manifestPaths: 'packages/*/package.json',
    dependencyFields: 'dependencies,devDependencies,peerDependencies',
    workspacePrefixes: '',
    allowlist: '',
    matchMode: 'table-row',
    cwd: process.cwd(),
  };
  const flagToKey = {
    '--doc-path': 'docPath',
    '--manifest-paths': 'manifestPaths',
    '--dependency-fields': 'dependencyFields',
    '--workspace-prefixes': 'workspacePrefixes',
    '--allowlist': 'allowlist',
    '--match-mode': 'matchMode',
    '--cwd': 'cwd',
  };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const key = flagToKey[flag];
    if (!key) {
      throw new Error(`check-dependency-inventory: unrecognized flag "${flag}"`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`check-dependency-inventory: "${flag}" needs a value`);
    }
    args[key] = value;
    i++;
  }
  if (!args.docPath) {
    throw new Error('check-dependency-inventory: --doc-path is required');
  }
  if (args.matchMode !== 'table-row' && args.matchMode !== 'substring') {
    throw new Error(
      `check-dependency-inventory: --match-mode must be "table-row" or "substring", got "${args.matchMode}"`,
    );
  }
  return args;
}

function splitList(value) {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Expand a manifest-path pattern containing at most one `*` path segment
 * into every matching real path, relative to `cwd`. A pattern with no `*`
 * is returned as-is (if the file exists) or dropped (if it doesn't — a repo
 * may list an optional manifest, e.g. a root package.json, that isn't
 * always a workspace root).
 */
function expandManifestPaths(pattern, cwd) {
  const segments = pattern.split('/');
  const starIndex = segments.indexOf('*');
  if (starIndex === -1) {
    try {
      readFileSync(path.join(cwd, pattern), 'utf8');
      return [pattern];
    } catch {
      return [];
    }
  }
  const dirSegments = segments.slice(0, starIndex);
  const dir = path.join(cwd, ...dirSegments);
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rest = segments.slice(starIndex + 1);
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => [...dirSegments, e.name, ...rest].join('/'));
}

/** Every direct dependency name declared in `manifest` across `fields`. */
function directDependencies(manifest, fields, workspacePrefixes) {
  const names = new Set();
  for (const field of fields) {
    for (const name of Object.keys(manifest[field] ?? {})) {
      if (workspacePrefixes.some((prefix) => name.startsWith(prefix))) continue;
      names.add(name);
    }
  }
  return names;
}

/** Names present as a `| \`name\` | ...` first-column code span. */
function tableRowNames(docText) {
  const names = new Set();
  for (const match of docText.matchAll(/^\|\s*`([^`]+)`\s*\|/gm)) {
    names.add(match[1]);
  }
  return names;
}

function isDocumented(name, docText, matchMode, tableNames) {
  return matchMode === 'table-row' ? tableNames.has(name) : docText.includes(name);
}

export function run(args) {
  const cwd = args.cwd;
  const manifestPatterns = splitList(args.manifestPaths);
  const fields = splitList(args.dependencyFields);
  const workspacePrefixes = splitList(args.workspacePrefixes);
  const allowlist = new Set(splitList(args.allowlist));

  const manifestPaths = manifestPatterns.flatMap((pattern) => expandManifestPaths(pattern, cwd));
  if (manifestPaths.length === 0) {
    console.error(
      `check-dependency-inventory: no manifests matched --manifest-paths "${args.manifestPaths}" under ${cwd}`,
    );
    return 1;
  }

  const declared = new Map(); // name -> first manifest that declared it
  for (const manifestPath of manifestPaths) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(path.join(cwd, manifestPath), 'utf8'));
    } catch {
      continue; // not a real manifest, or unreadable — skip rather than fail the whole run
    }
    for (const name of directDependencies(manifest, fields, workspacePrefixes)) {
      if (!declared.has(name)) declared.set(name, manifestPath);
    }
  }

  const docText = readFileSync(path.join(cwd, args.docPath), 'utf8');
  const tableNames = args.matchMode === 'table-row' ? tableRowNames(docText) : null;

  const missing = [...declared.keys()]
    .filter((name) => !allowlist.has(name))
    .filter((name) => !isDocumented(name, docText, args.matchMode, tableNames))
    .sort();

  if (missing.length === 0) {
    console.log(
      `check-dependency-inventory: OK — ${declared.size} direct dependencies checked against ${args.docPath}, all documented or allowlisted.`,
    );
    return 0;
  }

  console.error(`check-dependency-inventory: dependenc(y/ies) with no row in ${args.docPath}:`);
  for (const name of missing) {
    console.error(`  ${name}  (${declared.get(name)})`);
  }
  console.error('\nAdd a row for each, or add it to --allowlist if it genuinely needs none.');
  return 1;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  process.exit(run(args));
}

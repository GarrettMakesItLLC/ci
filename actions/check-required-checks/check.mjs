#!/usr/bin/env node
/**
 * Required-checks drift guard.
 *
 * A ruleset resolves a required check by NAME on the head SHA and does not care
 * which run wrote it. A promotion PR's head SHA is a trunk commit that already
 * carries every check its own merge-queue entry earned, including a green
 * `CI Success` from a lane where the batch gate legitimately skipped. A required
 * name is therefore only a gate if exactly one lane can emit it.
 *
 * `.github/required-checks.json` is the written intent a ruleset edit is made
 * against (the live ruleset needs an admin token CI does not have). This guard
 * enforces that the intent stays satisfiable against the workflow:
 *
 *   - every required name (gating and inherited) is emitted by exactly one job;
 *   - on a promotion branch a gating name is conditional on
 *     `github.base_ref == '<branch>'` and `pull_request`, and its job's `if:`
 *     narrows `always()` by that condition and by nothing else;
 *   - no two jobs can ever report the same name;
 *   - a name is never both gating and inherited;
 *   - the manifest's `integration_id` matches the GitHub Actions app.
 *
 * Read as TEXT, not parsed: no YAML parser is a dependency. Dependency-free plain node.
 */
import fs from 'node:fs';

export const ACTIONS_APP_ID = 15368;

/** Every job block under `jobs:`, keyed by job id, from its key to the next one. */
export function jobs(text) {
  const lines = text.split('\n');
  const jobsAt = lines.findIndex((l) => /^jobs:\s*(#.*)?$/.test(l));
  const out = new Map();
  if (jobsAt === -1) return out;
  const starts = [];
  for (let i = jobsAt + 1; i < lines.length; i++) {
    if (/^\S/.test(lines[i]) && !/^\s*#/.test(lines[i])) {
      starts.push([null, i]); // next top-level key ends the section
      break;
    }
    const m = /^ {2}([A-Za-z_][\w-]*):\s*(#.*)?$/.exec(lines[i]);
    if (m) starts.push([m[1], i]);
  }
  starts.forEach(([id, start], n) => {
    if (id === null) return;
    const end = n + 1 < starts.length ? starts[n + 1][1] : lines.length;
    out.set(id, lines.slice(start, end).join('\n'));
  });
  return out;
}

/** A block with whole-line comments removed; the prose names what it forbids. */
export function code(block) {
  return block
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n');
}

/** A job's `name:`, block scalar folded, comments stripped; '' when it declares none. */
export function nameExpression(block) {
  const lines = code(block).split('\n');
  const at = lines.findIndex((l) => /^ {4}name:/.test(l));
  if (at === -1) return '';
  const first = lines[at].replace(/^ {4}name:\s*/, '');
  if (!/^[>|]/.test(first)) return unquote(first.trim());
  const rest = [];
  for (let i = at + 1; i < lines.length; i++) {
    if (!/^ {6}\S/.test(lines[i])) break;
    rest.push(lines[i].trim());
  }
  return rest.join(' ');
}

function unquote(v) {
  if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) return v.slice(1, -1);
  return v;
}

// Operands of the comparisons inside a `name:` condition, never name candidates.
const OPERANDS = new Set(['pull_request', 'merge_group', 'push', 'main', 'dev', 'true', 'false', 'workflow_dispatch', 'schedule']);
const REF_LITERAL = /^refs\/(heads|tags)\//;

/** Every single-quoted literal a `name:` expression can resolve to. */
export function possibleNames(expr) {
  if (!expr.includes('${{')) return expr ? [expr] : [];
  return [...expr.matchAll(/'([^']*)'/g)]
    .map((m) => m[1])
    .filter((s) => !OPERANDS.has(s) && !REF_LITERAL.test(s) && s !== '');
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {{ workflow: string, manifest: any, promotionBranches?: string[], integrationId?: number | null }} input
 * @returns {string[]} problems
 */
export function audit({ workflow, manifest, promotionBranches = ['main'], integrationId = ACTIONS_APP_ID }) {
  const problems = [];
  const JOBS = jobs(workflow);
  if (JOBS.size === 0) {
    return ['the workflow declares no jobs under `jobs:`; a guard that matched nothing would pass forever'];
  }
  const external = new Set(Array.isArray(manifest.external) ? manifest.external : []);
  const inheritedBy = manifest.inherited && typeof manifest.inherited === 'object' ? manifest.inherited : {};
  const branches = Object.keys(manifest).filter((k) => !k.startsWith('$') && Array.isArray(manifest[k]) && k !== 'external');
  if (branches.length === 0) problems.push('the manifest names no branch (expected e.g. `"main": [...]`)');

  const emitters = (name) => [...JOBS].filter(([, block]) => possibleNames(nameExpression(block)).includes(name)).map(([id]) => id);

  // Uniqueness across the whole workflow, not just the required names: a new
  // job that happens to reuse one reopens the hole under a different name.
  const seen = new Map();
  for (const [id, block] of JOBS) {
    for (const name of possibleNames(nameExpression(block))) {
      const prior = seen.get(name);
      if (prior !== undefined && prior !== id) problems.push(`jobs \`${prior}\` and \`${id}\` can both report the check \`${name}\``);
      seen.set(name, id);
    }
  }

  if (integrationId !== null && manifest.integration_id !== undefined && manifest.integration_id !== integrationId) {
    problems.push(`manifest integration_id is ${manifest.integration_id}, expected the GitHub Actions app (${integrationId}); an unpinned check accepts a commit status of the same name from any token`);
  }

  for (const branch of branches) {
    const gating = manifest[branch];
    const inherited = Array.isArray(inheritedBy[branch]) ? inheritedBy[branch] : [];
    if (gating.length + inherited.length === 0) problems.push(`${branch} requires no checks at all, gating or inherited`);
    for (const n of gating.filter((c) => inherited.includes(c))) {
      problems.push(`${branch} lists \`${n}\` as both gating and inherited`);
    }
    const promotion = promotionBranches.includes(branch);

    for (const name of [...gating, ...inherited]) {
      if (external.has(name)) continue;
      const ids = emitters(name);
      if (ids.length !== 1) {
        problems.push(
          ids.length === 0
            ? `${branch}: required check \`${name}\` is emitted by no job (the ruleset would wait forever on a status nobody reports; list it under \`external\` if another workflow owns it)`
            : `${branch}: required check \`${name}\` is emitted by ${ids.length} jobs (${ids.join(', ')}); the ruleset cannot tell which it accepted`,
        );
      }
    }

    if (!promotion) continue;
    // A promotion PR's head SHA already carries the trunk's checks, so a name
    // gating the promotion must be unreachable from any lane but that PR.
    for (const name of gating) {
      if (external.has(name)) continue;
      const ids = emitters(name);
      if (ids.length !== 1) continue;
      const block = JOBS.get(ids[0]);
      const expr = nameExpression(block);
      if (!expr.includes('${{')) {
        problems.push(`${branch}: \`${name}\` is a static job name; every lane that reaches job \`${ids[0]}\` emits it, including the trunk's own merge-queue lane`);
        continue;
      }
      if (!expr.includes(`github.base_ref == '${branch}'`)) problems.push(`${branch}: \`${name}\` is not gated on github.base_ref == '${branch}'`);
      if (!expr.includes("github.event_name == 'pull_request'")) problems.push(`${branch}: \`${name}\` is not gated on the pull_request event`);
      // A job skipped by its own `if:` still leaves a check run, and a skipped
      // check satisfies a required one. A skip is safe only where the name
      // condition is false, so `if:` may narrow `always()` by that condition and
      // nothing else.
      const condition = new RegExp(`^\\$\\{\\{\\s*\\((.+)\\)\\s*&&\\s*'${escapeRe(name)}'\\s*\\|\\|`)
        .exec(expr)?.[1]
        ?.replace(/\s+/g, ' ')
        .trim();
      if (condition === undefined) {
        problems.push(`${branch}: \`${name}\`'s name is not \`(<condition>) && '<name>' || ...\`, so its lane condition cannot be read`);
        continue;
      }
      const gate = /^ {4}if: (.+)$/m.exec(code(block))?.[1]?.trim();
      if (gate !== 'always()' && gate !== `always() && ${condition}`) {
        problems.push(`${branch}: job \`${ids[0]}\` (\`${name}\`) has \`if: ${gate ?? '(none)'}\`; it may be \`always()\` or \`always() && ${condition}\` and nothing narrower, or a lane that owes the verdict can skip`);
      }
    }
  }
  return problems;
}

function main() {
  const workflowPath = process.env.RC_CI_WORKFLOW || '.github/workflows/ci.yml';
  const manifestPath = process.env.RC_MANIFEST || '.github/required-checks.json';
  const promotion = (process.env.RC_PROMOTION_BRANCHES ?? 'main').split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const idRaw = (process.env.RC_INTEGRATION_ID ?? String(ACTIONS_APP_ID)).trim();
  let problems;
  try {
    problems = audit({
      workflow: fs.readFileSync(workflowPath, 'utf8'),
      manifest: JSON.parse(fs.readFileSync(manifestPath, 'utf8')),
      promotionBranches: promotion,
      integrationId: idRaw === '' ? null : Number(idRaw),
    });
  } catch (e) {
    console.error(`::error::cannot read ${workflowPath} / ${manifestPath}: ${e.message}`);
    process.exit(1);
  }
  if (problems.length > 0) {
    for (const p of problems) console.error(`::error title=Required checks drift::${p}`);
    console.error(`\ncheck-required-checks: ${problems.length} problem(s). Change a required check in the workflow, ${manifestPath} and the ruleset together.`);
    process.exit(1);
  }
  console.log(`Required checks in ${manifestPath} match what ${workflowPath} emits.`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

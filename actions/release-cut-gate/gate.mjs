#!/usr/bin/env node
/**
 * Release-cut gate: is anything about to land on `dev`?
 *
 * A cut freezes `dev` at one commit for the promotion's E2E gate. A PR that
 * merges minutes later misses that promotion and waits for the next one, and
 * "close the promotion and re-cut" to pick it up throws away the gate time
 * already spent. So a cut waits until the PRs already on their way in have
 * landed, and promotions batch instead of chasing each merge.
 *
 * About to land means either:
 *   - an entry in the `dev` merge queue (other than one GitHub has already
 *     judged UNMERGEABLE, which is on its way out, not in), or
 *   - an open PR into `dev` with auto-merge armed or sitting in the queue,
 *     whose checks are pending or green. A red PR is not about to merge.
 *
 * Verdicts by trigger:
 *   - `workflow_dispatch`: refuse (exit 1) and name the PRs; `force` overrides.
 *   - `schedule`: never fail. Skip the cut, say why in the step summary, and the
 *     next night's run tries again.
 *
 * Plain JS with no dependencies: importable for the pure `cutGateDecision`
 * (`gate.test.mjs`), runnable as the CLI `action.yml` calls, which reads the
 * live state through `gh api graphql`. A repo with no merge queue on the branch
 * (`mergeQueue` null) still has its armed PRs checked, and passes when none.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** Rollup states that mean "still running" or "will merge when the queue gets to it". */
const LANDING_ROLLUP = new Set(['PENDING', 'EXPECTED', 'SUCCESS']);

/**
 * @typedef {{ number: number, title: string }} PrRef
 * @typedef {{ state: string, pullRequest: PrRef | null }} QueueEntry
 * @typedef {{
 *   number: number,
 *   title: string,
 *   isDraft?: boolean,
 *   isInMergeQueue?: boolean,
 *   autoMergeRequest?: object | null,
 *   rollup?: string | null,
 * }} OpenPr
 * @typedef {{ number: number, title: string, reason: string }} Blocker
 */

/**
 * @param {{ queueEntries: QueueEntry[], openPrs: OpenPr[], event: string, force: boolean }} input
 * @returns {{ proceed: boolean, fail: boolean, blockers: Blocker[], message: string }}
 */
export function cutGateDecision({ queueEntries, openPrs, event, force }) {
  /** @type {Map<number, Blocker>} */
  const blockers = new Map();

  for (const entry of queueEntries) {
    if (!entry.pullRequest || entry.state === 'UNMERGEABLE') continue;
    const { number, title } = entry.pullRequest;
    blockers.set(number, { number, title, reason: `in the merge queue (${entry.state})` });
  }

  for (const pr of openPrs) {
    if (blockers.has(pr.number)) continue;
    const armed = pr.autoMergeRequest != null;
    if (!armed && !pr.isInMergeQueue) continue;
    // The token could not read the rollup (no `checks`/`statuses` grant). A
    // queued PR is landing whatever its checks say; an armed one is not
    // assumed to be — a red PR stays armed, and would hold every cut.
    if (pr.rollup === 'UNREADABLE' && !pr.isInMergeQueue) continue;
    // No rollup yet means no check has reported: that is pending, not red.
    const rollup = pr.rollup ?? 'PENDING';
    if (rollup !== 'UNREADABLE' && !LANDING_ROLLUP.has(rollup)) continue;
    const how = pr.isInMergeQueue ? 'in the merge queue' : 'auto-merge armed';
    blockers.set(pr.number, {
      number: pr.number,
      title: pr.title,
      reason: `${how}, checks ${rollup.toLowerCase()}`,
    });
  }

  const list = [...blockers.values()].sort((a, b) => a.number - b.number);
  if (list.length === 0) {
    return {
      proceed: true,
      fail: false,
      blockers: list,
      message: 'Nothing is about to land on the branch. Cutting.',
    };
  }

  const names = list.map((b) => `  - #${b.number} ${b.title} (${b.reason})`).join('\n');
  if (force) {
    return {
      proceed: true,
      fail: false,
      blockers: list,
      message: `force is set: cutting even though these PRs are about to land on the branch and will miss this promotion:\n${names}`,
    };
  }
  if (event === 'schedule') {
    return {
      proceed: false,
      fail: false,
      blockers: list,
      message: `Skipping tonight's cut: these PRs are about to land on the branch, and the next scheduled run picks them up:\n${names}`,
    };
  }
  return {
    proceed: false,
    fail: true,
    blockers: list,
    message:
      `Refusing to cut: these PRs are about to land on the branch:\n${names}\n` +
      'Cut after they land, so they ride this promotion instead of the next one. ' +
      'Override with the `force` input.',
  };
}

const QUERY = `
query($owner: String!, $name: String!, $branch: String!) {
  repository(owner: $owner, name: $name) {
    mergeQueue(branch: $branch) {
      entries(first: 100) { nodes { state pullRequest { number title } } }
    }
    pullRequests(states: OPEN, baseRefName: $branch, first: 100) {
      nodes {
        number
        title
        isDraft
        isInMergeQueue
        autoMergeRequest { enabledAt }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
      }
    }
  }
}`;

/**
 * Whether the response's errors say the token may not read check rollups.
 * @param {unknown} errors
 */
export function rollupForbidden(errors) {
  if (!Array.isArray(errors)) return false;
  return errors.some(
    (e) =>
      Array.isArray(e?.path) &&
      e.path.includes('statusCheckRollup') &&
      (e.type === 'FORBIDDEN' || /not accessible/i.test(String(e.message))),
  );
}

/** @param {string} repository `owner/name` */
function fetchState(repository, branch) {
  const [owner, name] = repository.split('/');
  // `gh api graphql` exits non-zero on a PARTIAL error too — the rollup field
  // answers FORBIDDEN to a token without `checks`/`statuses` while the rest of
  // the response is fine — so the body is read whatever the exit code, and
  // only a response with no repository at all is fatal.
  const res = spawnSync(
    'gh',
    ['api', 'graphql', '-f', `query=${QUERY}`, '-F', `owner=${owner}`, '-F', `name=${name}`, '-F', `branch=${branch}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] },
  );
  let body;
  try {
    body = JSON.parse(res.stdout);
  } catch {
    throw new Error(`gh api graphql failed (exit ${res.status}) with no JSON body`);
  }
  const repo = body?.data?.repository;
  if (!repo) throw new Error(`gh api graphql returned no repository: ${JSON.stringify(body?.errors ?? body)}`);
  const rollupUnreadable = rollupForbidden(body.errors);
  /** @type {QueueEntry[]} */
  const queueEntries = repo.mergeQueue?.entries?.nodes ?? [];
  /** @type {OpenPr[]} */
  const openPrs = (repo.pullRequests?.nodes ?? []).map((/** @type {any} */ n) => ({
    number: n.number,
    title: n.title,
    isDraft: n.isDraft,
    isInMergeQueue: n.isInMergeQueue,
    autoMergeRequest: n.autoMergeRequest,
    rollup: rollupUnreadable
      ? 'UNREADABLE'
      : (n.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state ?? null),
  }));
  return { queueEntries, openPrs };
}

function main() {
  const repository = process.env.GITHUB_REPOSITORY;
  if (!repository) throw new Error('GITHUB_REPOSITORY is not set');
  const event = process.env.GATE_EVENT ?? 'workflow_dispatch';
  const force = process.env.GATE_FORCE === 'true';

  const decision = cutGateDecision({ ...fetchState(repository, process.env.GATE_BRANCH || 'dev'), event, force });

  console.log(decision.message);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### Release-cut gate\n\n${decision.message}\n`,
    );
  }
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `proceed=${decision.proceed}\n`);
  }
  if (decision.fail) {
    console.log(`::error title=Release cut refused::${decision.message.replace(/\n/g, '%0A')}`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();

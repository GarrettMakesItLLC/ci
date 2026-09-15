#!/usr/bin/env node
/**
 * Fixture test for `deployDecision` (ci#62). No test runner in this repo —
 * self-check.yml runs this file directly with `node` and treats a non-zero
 * exit as a failure, same as `deploy-target.mjs`'s own CLI contract.
 *
 * Every case names the donor shape it stands in for, so a change here that
 * silently narrows a fail-open path is visible in the diff, not just in a
 * red run.
 */
import assert from 'node:assert/strict';
import { deployDecision } from './deploy-target.mjs';

const cases = [
  {
    name: 'branch+paths combo that SHOULD deploy (ref match AND matching path)',
    input: {
      gitRef: 'dev',
      alwaysBuildRefs: ['dev'],
      alwaysBuildRefPrefixes: ['release/'],
      pathPrefixes: ['apps/web/', 'packages/'],
      changedPaths: ['apps/web/src/App.tsx'],
    },
    expectBuild: true,
  },
  {
    name: 'feature branch + matching path (RedThreadEvents shape) SHOULD deploy',
    input: {
      gitRef: 'feature/x',
      alwaysBuildRefs: ['dev', 'main'],
      alwaysBuildRefPrefixes: ['release/'],
      pathPrefixes: ['apps/web/', 'packages/'],
      changedPaths: ['packages/engine/src/index.ts'],
    },
    expectBuild: true,
  },
  {
    name: 'wrong branch: feature branch, ref-only gate (MuscleBuddy shape) SHOULD NOT deploy',
    input: {
      gitRef: 'feature/x',
      alwaysBuildRefs: ['dev'],
      alwaysBuildRefPrefixes: ['release/'],
    },
    expectBuild: false,
  },
  {
    name: 'no matching path changed: feature branch, path gate configured SHOULD NOT deploy',
    input: {
      gitRef: 'feature/x',
      alwaysBuildRefs: ['dev', 'main'],
      alwaysBuildRefPrefixes: ['release/'],
      pathPrefixes: ['apps/web/', 'packages/'],
      changedPaths: ['apps/server/index.ts', 'prisma/schema.prisma'],
    },
    expectBuild: false,
  },
  {
    name: 'release/* branch always deploys regardless of paths',
    input: {
      gitRef: 'release/2026.09',
      alwaysBuildRefs: ['dev'],
      alwaysBuildRefPrefixes: ['release/'],
      pathPrefixes: ['apps/web/'],
      changedPaths: ['prisma/schema.prisma'],
    },
    expectBuild: true,
  },
  {
    name: 'VERCEL_ENV=production always deploys, even force-skip cannot override paths absence',
    input: { vercelEnv: 'production', gitRef: 'feature/x' },
    expectBuild: true,
  },
  {
    name: 'force-skip wins over an otherwise-deploying ref (MuscleBuddy demo surface)',
    input: {
      gitRef: 'dev',
      alwaysBuildRefs: ['dev'],
      forceSkip: true,
      forceSkipReason: 'the demo project serves only its production branch',
    },
    expectBuild: false,
  },
  {
    name: 'unknown changed paths fails open (build) even off a feature branch',
    input: {
      gitRef: 'feature/x',
      alwaysBuildRefs: ['dev'],
      pathPrefixes: ['apps/web/'],
      changedPaths: null,
    },
    expectBuild: true,
  },
  {
    name: 'empty ref fails open (build)',
    input: { gitRef: '' },
    expectBuild: true,
  },
];

let failed = 0;
for (const { name, input, expectBuild } of cases) {
  const decision = deployDecision(input);
  try {
    assert.equal(decision.build, expectBuild, `expected build=${expectBuild}, got build=${decision.build} (${decision.reason})`);
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAIL - ${name}`);
    console.error(`       ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`\n${failed}/${cases.length} fixture case(s) failed`);
  process.exit(1);
}
console.log(`\nall ${cases.length} fixture cases passed`);

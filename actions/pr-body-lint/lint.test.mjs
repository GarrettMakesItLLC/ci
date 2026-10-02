import assert from 'node:assert/strict';
import { test } from 'node:test';
import { lintPrBody } from './lint.mjs';

const rules = (body) => lintPrBody(body).map((f) => f.rule);

test('clean bodies', () => {
  for (const b of ['Closes #12', 'Closes #12, Closes #34', 'see #12 and #34', 'Closes #1\nCloses #2', '', 'builds on #456']) {
    assert.deepEqual(rules(b), [], b);
  }
});

test('negated closing keyword (MuscleBuddy #4929)', () => {
  assert.deepEqual(rules('Does not close #4885, the recapture is still owed.'), ['negated-close']);
  assert.deepEqual(rules('Not closing #9'), ['negated-close']);
});

// Regression: `n't` sat behind a \b that cannot match inside "doesn't", so a
// contraction slipped through the vendored copy.
test("regression: a contraction negates (doesn't / won't / isn't)", () => {
  assert.deepEqual(rules("This doesn't close #12"), ['negated-close']);
  assert.deepEqual(rules("This won't fix #12"), ['negated-close']);
});

// Regression: MuscleBuddy's second linter caught these two, the shared one did not.
test('regression: no / without negate', () => {
  assert.deepEqual(rules('without closes #5'), ['negated-close']);
  assert.deepEqual(rules('no fixes #5 here'), ['negated-close']);
});

test('comma list (MuscleBuddy #4597)', () => {
  assert.deepEqual(rules('Closes #4879, #4885'), ['comma-list']);
});

// Regression: "X and #N" closed only the first issue and passed the shared lint.
test('regression: "and" / ", and" / "&" lists bind one issue', () => {
  assert.deepEqual(rules('Fixes #3 and #4'), ['comma-list']);
  assert.deepEqual(rules('Closes #1, and #2'), ['comma-list']);
  assert.deepEqual(rules('Resolves #1 & #2'), ['comma-list']);
});

test('quoted syntax in code is not a trap', () => {
  assert.deepEqual(rules('The lint flags `Closes #1, #2` as a trap.'), []);
  assert.deepEqual(rules('```\nCloses #1 and #2\n```'), []);
});

test('a keyword not adjacent to the reference is not a trap', () => {
  assert.deepEqual(rules('fixes the crash #123 and #124'), []);
});

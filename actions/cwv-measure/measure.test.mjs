import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAbortPatterns, parseLocalStorage, thirdPartyTransfer, thirdPartyVerdict } from './measure.mjs';

test('local-storage: empty is none, objects of strings pass, anything else is refused', () => {
  assert.deepEqual(parseLocalStorage(''), {});
  assert.deepEqual(parseLocalStorage('{"a":"b"}'), { a: 'b' });
  assert.throws(() => parseLocalStorage('[1]'), /JSON object/);
  assert.throws(() => parseLocalStorage('{"a":1}'), /must be a string/);
  assert.throws(() => parseLocalStorage('{nope'), /not JSON/);
});

test('abort-url-patterns: one regular expression per line, comments and blanks skipped', () => {
  const patterns = parseAbortPatterns('# collection\n\nhttps://www\\.google-analytics\\.com/g/collect\nfacebook\\.com/tr\n');
  assert.equal(patterns.length, 2);
  assert.ok(patterns[0].test('https://www.google-analytics.com/g/collect?v=2'));
  assert.ok(!patterns[0].test('https://example.com/'));
  assert.throws(() => parseAbortPatterns('('), /Invalid regular expression/);
});

test('third-party transfer counts only off-origin requests, and only their sized bytes', () => {
  const items = [
    { url: 'https://site.test/app.js', transferSize: 1000 },
    { url: 'https://vendor.test/tag.js', transferSize: 2048 },
    { url: 'https://vendor.test/aborted' },
    { url: 'data:image/png;base64,AAAA', transferSize: 9 },
    { url: 'https://other.test/x', transferSize: 100 },
  ];
  assert.deepEqual(thirdPartyTransfer(items, 'https://site.test/pricing'), { bytes: 2148, requests: 3 });
  assert.deepEqual(thirdPartyTransfer([], 'https://site.test/'), { bytes: 0, requests: 0 });
});

test('third-party verdict discards a run that is not the state asked for', () => {
  assert.equal(thirdPartyVerdict('any', 0), undefined);
  assert.equal(thirdPartyVerdict('required', 3), undefined);
  assert.match(thirdPartyVerdict('required', 0), /did not take/);
  assert.equal(thirdPartyVerdict('none', 0), undefined);
  assert.match(thirdPartyVerdict('none', 2), /2 third-party/);
});

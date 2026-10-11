import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { connect } from 'node:http2';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { startH2Front } from './h2-front.mjs';

/** A plain HTTP/1.1 upstream that records what it was sent. */
async function upstream(handler) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, headers: req.headers });
    handler(req, res);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, seen, close: () => new Promise((r) => server.close(r)) };
}

/** GET over HTTP/2, trusting only the front's own certificate (no verification opt-out). */
function get(front, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const session = connect(front.origin, { ca: front.cert });
    session.on('error', reject);
    const req = session.request({ ':path': path, ...headers });
    const chunks = [];
    let head;
    req.on('response', (h) => {
      head = h;
    });
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const alpn = session.alpnProtocol;
      session.close();
      resolve({ head, body: Buffer.concat(chunks), alpn });
    });
    req.on('error', reject);
    req.end();
  });
}

test('h2 front: negotiates h2, forwards path and status, passes content-encoding through untouched', async () => {
  const gz = gzipSync('<html>hello</html>');
  const up = await upstream((req, res) => {
    res.writeHead(req.url === '/missing' ? 404 : 200, { 'content-type': 'text/html', 'content-encoding': 'gzip', connection: 'keep-alive', 'keep-alive': 'timeout=5' });
    res.end(gz);
  });
  const front = await startH2Front(up.origin);
  try {
    const r = await get(front, '/pricing?x=1', { 'accept-encoding': 'gzip' });
    assert.equal(r.alpn, 'h2');
    assert.equal(r.head[':status'], 200);
    assert.equal(r.head['content-encoding'], 'gzip');
    assert.equal(r.head.connection, undefined);
    assert.equal(r.head['keep-alive'], undefined);
    assert.deepEqual(r.body, gz);
    assert.equal(up.seen[0].url, '/pricing?x=1');
    assert.equal(up.seen[0].headers.host, new URL(up.origin).host);
    assert.equal(up.seen[0].headers['accept-encoding'], 'gzip');
    assert.equal((await get(front, '/missing')).head[':status'], 404);
  } finally {
    await front.close();
    await up.close();
  }
});

test('h2 front: an upstream that is not answering is a 502, not a hang', async () => {
  const up = await upstream((_req, res) => res.end());
  const dead = up.origin;
  await up.close();
  const front = await startH2Front(dead);
  try {
    const r = await get(front, '/');
    assert.equal(r.head[':status'], 502);
  } finally {
    await front.close();
  }
});

test('h2 front: exposes the SPKI pin Chrome needs, and refuses a non-http upstream', async () => {
  const up = await upstream((_req, res) => res.end());
  const front = await startH2Front(up.origin);
  try {
    assert.match(front.spkiSha256, /^[A-Za-z0-9+/]{43}=$/);
    assert.match(front.origin, /^https:\/\/127\.0\.0\.1:\d+$/);
  } finally {
    await front.close();
    await up.close();
  }
  await assert.rejects(startH2Front('https://example.com'), /plain http/);
});

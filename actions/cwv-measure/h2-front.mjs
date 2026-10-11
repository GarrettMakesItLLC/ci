// An HTTP/2 front for a local preview server, so Lighthouse measures the transport production uses.
//
// A local preview (`vite preview` and most static servers) speaks HTTP/1.1; the CDN in front of
// production speaks HTTP/2. Lighthouse's simulated throttling models HTTP/1.1's six-connection cap
// per origin, so on a page with dozens of modulepreloaded chunks the rig charges every route a queue
// production does not have — measured at ~1.3 s of simulated LCP on MuscleBuddy (MuscleBuddy#6188).
//
// A reverse proxy, not a server: the upstream keeps owning content types, clean-URL rewrites and
// the SPA fallback, and `content-encoding` passes through untouched, so the compression Lighthouse
// observes is the one the upstream negotiated. Browsers only speak HTTP/2 over TLS, so the front
// presents a throwaway self-signed certificate; Chrome is told to accept exactly that key
// (`--ignore-certificate-errors-spki-list`), never every bad certificate.
//
// Request bodies are not forwarded: a Lighthouse navigation of a static preview only issues GETs.
// No dependencies, so it is testable without installing Lighthouse.
import { execFileSync } from 'node:child_process';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createSecureServer } from 'node:http2';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Connection-scoped in HTTP/1.1 and illegal in HTTP/2. */
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade']);

/** A certificate for 127.0.0.1, valid one day. `openssl` is on the runner image; a missing one throws, which is a rig failure. */
function generateCert(dir) {
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execFileSync(
    'openssl',
    ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '1', '-nodes', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost'],
    { stdio: 'pipe' },
  );
  return { key: readFileSync(keyPath), cert: readFileSync(certPath) };
}

/**
 * Start an HTTP/2 reverse proxy in front of `upstream` (an `http://` origin) on 127.0.0.1:`port`
 * (0 picks a free port).
 *
 * @returns {Promise<{ origin: string, cert: string, spkiSha256: string, close: () => Promise<void> }>}
 */
export async function startH2Front(upstream, port = 0) {
  const target = new URL(upstream);
  if (target.protocol !== 'http:') throw new Error(`the HTTP/2 front proxies a plain http:// origin, got ${upstream}`);
  const dir = mkdtempSync(join(tmpdir(), 'cwv-h2-'));
  const { key, cert } = generateCert(dir);
  // allowHTTP1 so a non-ALPN client gets an answer rather than a reset; Chrome negotiates h2.
  const server = createSecureServer({ key, cert, allowHTTP1: true });

  server.on('stream', (stream, headers) => {
    const forwarded = {};
    for (const [name, value] of Object.entries(headers)) {
      if (name.startsWith(':') || HOP_BY_HOP.has(name) || value === undefined) continue;
      forwarded[name] = Array.isArray(value) ? value.join(', ') : String(value);
    }
    // The upstream's own host check must see where the request is actually going.
    forwarded.host = target.host;
    const upstreamRequest = request(
      { host: target.hostname, port: Number(target.port || 80), path: String(headers[':path'] ?? '/'), method: String(headers[':method'] ?? 'GET'), headers: forwarded },
      (response) => {
        const out = { ':status': String(response.statusCode ?? 502) };
        for (const [name, value] of Object.entries(response.headers)) {
          if (HOP_BY_HOP.has(name) || value === undefined) continue;
          out[name] = value;
        }
        try {
          stream.respond(out);
        } catch {
          response.destroy(); // the client hung up between the upstream answering and here
          return;
        }
        response.pipe(stream);
      },
    );
    upstreamRequest.on('error', (error) => {
      try {
        stream.respond({ ':status': 502 });
        stream.end(`upstream error: ${error.message}`);
      } catch {
        // already closed
      }
    });
    upstreamRequest.end();
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === 'string') throw new Error('the HTTP/2 front did not bind');
  return {
    origin: `https://127.0.0.1:${bound.port}`,
    cert: cert.toString(),
    spkiSha256: createHash('sha256').update(new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64'),
    close: () =>
      new Promise((resolve) => {
        server.close(() => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
      }),
  };
}

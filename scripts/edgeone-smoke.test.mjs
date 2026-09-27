import assert from 'node:assert/strict';
import test from 'node:test';
import { checkPublicWeb, waitForPublicWeb } from './edgeone-smoke.mjs';

const origin = 'https://web.example.invalid';
const sandbox = 'https://sandbox.example.invalid';
const csp = `default-src 'self'; connect-src 'self' ${sandbox}; frame-ancestors 'none'`;

function replies(overrides = {}) {
  const routes = {
    '/auth/login': new Response('<div id="root"></div>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp },
    }),
    '/workspace': new Response('<div id="root"></div>', {
      headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': csp },
    }),
    '/api/healthz': Response.json({ status: 'ok' }),
    '/api/auth/session': Response.json({ error: { id: 'session_required' } }, { status: 401 }),
    ...overrides,
  };
  const requested = [];
  return {
    requested,
    fetch: async (url, options) => {
      assert.equal(url.origin, origin);
      assert.equal(options.redirect, 'manual');
      assert.equal(options.credentials, 'omit');
      requested.push(url.pathname);
      return routes[url.pathname].clone();
    },
  };
}

test('public smoke checks the SPA, exact CSP and anonymous API JSON', async () => {
  const stub = replies();
  await checkPublicWeb(origin, sandbox, stub.fetch);
  assert.deepEqual(stub.requested, ['/auth/login', '/workspace', '/api/healthz', '/api/auth/session']);
});

test('public smoke refuses HTML API fallbacks, missing SPA rewrites and permissive CSP', async () => {
  for (const [path, response] of [
    ['/workspace', new Response('not found', { status: 404, headers: { 'Content-Type': 'text/html' } })],
    ['/api/auth/session', new Response('<html>oops</html>', { status: 404, headers: { 'Content-Type': 'text/html' } })],
    ['/api/auth/session', new Response('<html>oops</html>', { headers: { 'Content-Type': 'text/html' } })],
    ['/auth/login', new Response('<div id="root"></div>', { headers: { 'Content-Type': 'text/html', 'Content-Security-Policy': "connect-src *; frame-ancestors 'none'" } })],
  ]) {
    await assert.rejects(checkPublicWeb(origin, sandbox, replies({ [path]: response }).fetch));
  }
});

test('public smoke requires three consecutive healthy checks and rejects flapping', async () => {
  let calls = 0;
  const good = replies().fetch;
  const pause = async () => {};
  await waitForPublicWeb(origin, sandbox, 4, async (...args) => {
    if (calls++ === 0) return new Response(null, { status: 404 });
    return good(...args);
  }, pause);
  assert.equal(calls, 13);
  let checks = 0;
  let requests = 0;
  await assert.rejects(waitForPublicWeb(origin, sandbox, 6, async (...args) => {
    requests++;
    if (args[0].pathname === '/auth/login' && ++checks % 2 === 0) {
      return new Response(null, { status: 502 });
    }
    return good(...args);
  }, pause));
  assert.equal(checks, 6);
  assert.equal(requests, 15);
  await assert.rejects(waitForPublicWeb(origin, sandbox, 2, async () => new Response(null, { status: 404 }), pause));
});

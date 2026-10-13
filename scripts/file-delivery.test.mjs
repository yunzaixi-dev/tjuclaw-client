import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/lib/file-delivery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { fetchAttachment, FileFetchError } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const origin = 'https://app.example.invalid';
const path = `/api/entries/${'b'.repeat(32)}/image?target=assets%2Fimage.png&v=revision`;
const signedAt = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const remote = `https://${'a'.repeat(32)}.r2.cloudflarestorage.com/forgejo-lfs/lfs/aa/bb/${'c'.repeat(64)}?X-Amz-Date=${signedAt}&X-Amz-Expires=300&X-Amz-Signature=synthetic`;
const bytes = 'synthetic file bytes';
const directTicket = (overrides = {}) => new Response(JSON.stringify({ download: {
  url: remote, expires_at: new Date(Date.now() + 300_000).toISOString(),
  filename: '原件.png', content_type: 'image/png', size: Buffer.byteLength(bytes), ...overrides,
} }), { headers: { 'Content-Type': 'application/json', 'X-TJUClaw-File-Delivery': 'r2' } });
const binary = () => new Response(bytes, { headers: { 'Content-Type': 'image/png', 'Content-Disposition': 'attachment; filename="original.png"' } });

test('a direct ticket fetches R2 without cookies or referrer and keeps the filename', async () => {
  const calls = [];
  const result = await fetchAttachment(path, { origin, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? directTicket() : binary();
  } });
  assert.equal(await result.blob.text(), bytes);
  assert.equal(result.filename, '原件.png');
  assert.equal(new URL(calls[0].url).searchParams.get('delivery'), 'direct');
  assert.equal(new URL(calls[0].url).searchParams.get('v'), 'revision');
  assert.equal(calls[0].options.credentials, 'same-origin');
  assert.equal(calls[1].url, remote);
  assert.equal(calls[1].options.credentials, 'omit');
  assert.equal(calls[1].options.referrerPolicy, 'no-referrer');
  assert.equal(calls[1].options.redirect, 'error');
  assert.equal(calls[1].options.cache, 'no-store');
});

test('an old API or uploaded JSON attachment stays a single binary request', async () => {
  let requests = 0;
  const result = await fetchAttachment(path, { origin, fetchImpl: async () => {
    requests++;
    return new Response('{"download":"actual user file"}', { headers: { 'Content-Type': 'application/json' } });
  } });
  assert.equal(await result.blob.text(), '{"download":"actual user file"}');
  assert.equal(requests, 1);
});

test('native clients use the existing API because their CSP does not allow R2', async () => {
  for (const nativeOrigin of [origin, 'tauri://localhost']) {
    await fetchAttachment(path, { origin: nativeOrigin, native: true, fetchImpl: async url => {
      assert.equal(new URL(url).searchParams.has('delivery'), false);
      assert.equal(new URL(url).host, new URL(nativeOrigin).host);
      return binary();
    } });
  }
});

test('invalid or expired tickets never make remote requests and use the original route', async () => {
  for (const overrides of [
    { url: remote.replace('.r2.cloudflarestorage.com', '.attacker.invalid') },
    { url: remote.replace('https:', 'http:') },
    { url: remote.replace('https://', 'https://user@') },
    { url: `${remote}#fragment` },
    { url: remote.replace('Expires=300', 'Expires=86401') },
    { url: remote.replace('X-Amz-Date=', 'invalid-date=') },
    { expires_at: new Date(Date.now() - 1000).toISOString() },
    { expires_at: new Date(Date.now() + 3600_000).toISOString() },
    { size: 9 * 1024 * 1024 },
    { size: 1.5 },
  ]) {
    let requests = 0;
    const result = await fetchAttachment(path, { origin, fetchImpl: async url => {
      requests++;
      assert.equal(new URL(url).origin, origin);
      if (requests === 1) return directTicket(overrides);
      assert.equal(new URL(url).searchParams.has('delivery'), false);
      assert.equal(new URL(url).searchParams.get('v'), 'revision');
      return binary();
    } });
    assert.equal(await result.blob.text(), bytes);
    assert.equal(requests, 2);
  }
});

test('R2 denials, CORS failures and wrong bytes fall back without clearing the session', async () => {
  for (const failure of [
    () => new Response(null, { status: 403 }),
    () => new Response(null, { status: 401 }),
    () => { throw new TypeError('Failed to fetch'); },
    () => new Response('partial', { headers: { 'Content-Type': 'image/png' } }),
    () => new Response(bytes, { headers: { 'Content-Type': 'text/html' } }),
  ]) {
    let requests = 0, unauthorized = 0;
    const result = await fetchAttachment(path, { origin, onUnauthorized: () => unauthorized++, fetchImpl: async url => {
      if (++requests === 1) return directTicket();
      if (new URL(url).origin !== origin) return failure();
      return binary();
    } });
    assert.equal(await result.blob.text(), bytes);
    assert.equal(requests, 3);
    assert.equal(unauthorized, 0);
  }
});

test('only an API 401 clears session state; an API 404 never tries R2', async () => {
  for (const status of [401, 404]) {
    let requests = 0, unauthorized = 0;
    await assert.rejects(fetchAttachment(path, { origin, onUnauthorized: () => unauthorized++, fetchImpl: async () => {
      requests++;
      return new Response(null, { status });
    } }), error => error instanceof FileFetchError && error.status === status);
    assert.equal(requests, 1);
    assert.equal(unauthorized, status === 401 ? 1 : 0);
  }
});

test('logout cancels the remote read and does not start a fallback request', async () => {
  const controller = new AbortController();
  let requests = 0;
  await assert.rejects(fetchAttachment(path, { origin, signal: controller.signal, fetchImpl: async (_url, options) => {
    if (++requests === 1) return directTicket();
    controller.abort();
    assert.equal(options.signal.aborted, true);
    throw new DOMException('canceled', 'AbortError');
  } }), { name: 'AbortError' });
  assert.equal(requests, 2);
});

test('Forgejo generic LFS media types become the authenticated image type', async () => {
  for (const type of ['application/octet-stream', '']) {
    let requests = 0;
    const result = await fetchAttachment(path, { origin, fetchImpl: async () => {
      if (++requests === 1) return directTicket();
      return new Response(new Blob([bytes], { type }));
    } });
    assert.equal(await result.blob.text(), bytes);
    assert.equal(result.blob.type, 'image/png');
    assert.equal(requests, 2);
  }
});

test('old Gateway falls back to the known file route and API 401 never falls back', async () => {
  const fallback = `/api/entries/${'c'.repeat(32)}/file?v=old`;
  for (const status of [404, 503, 401]) {
    const calls = [];
    const promise = fetchAttachment(path, { origin, fallback, fetchImpl: async url => {
      calls.push(url);
      return calls.length === 1 ? new Response(null, { status }) : binary();
    } });
    if (status === 401) {
      await assert.rejects(promise, error => error instanceof FileFetchError && error.status === 401);
      assert.equal(calls.length, 1);
    } else {
      assert.equal(await (await promise).blob.text(), bytes);
      assert.equal(calls[1], new URL(fallback, origin).href);
    }
  }
});

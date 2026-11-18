import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest } from '../functions/api/[[path]].js';

const session = `/api/sessions/${'a'.repeat(32)}`;

test('EdgeOne gives chat requests time to outlive its default response timeout', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));
  const cases = [
    ['POST', `${session}/messages`, 200_000],
    ['GET', `${session}/live?timeline=1`, 30_000],
    ['GET', `${session}?settled=1`, 95_000],
    ['GET', session, undefined],
    ['GET', `${session}/messages`, undefined],
    ['POST', '/api/auth/login', undefined],
  ];
  for (const [method, path, timeout] of cases) {
    const request = new Request(`https://app.example.invalid${path}`, { method });
    assert.equal((await onRequest({ request })).status, 200);
    const [target, init] = fetch.mock.calls.at(-1).arguments;
    assert.equal(target.pathname + target.search, path);
    assert.equal(init.method, method);
    assert.equal(init.redirect, 'manual');
    assert.equal(init.eo?.timeoutSetting.readTimeout, timeout, `${method} ${path}`);
  }
});

test('EdgeOne forwards a live frame before upstream closes and does not cache it', async t => {
  let frames;
  const upstream = new Response(new ReadableStream({ start(controller) { frames = controller; } }), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
  const fetch = t.mock.method(globalThis, 'fetch', async () => upstream);
  const response = await onRequest({ request: new Request(`https://app.example.invalid${session}/live`, {
    headers: { Accept: 'text/event-stream' },
  }) });
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const stream = response.body.getReader();
  try {
    const frame = new TextEncoder().encode('data: {"text":"你好"}\n\n');
    frames.enqueue(frame);
    assert.deepEqual(await stream.read(), { value: frame, done: false });
    assert.equal(fetch.mock.callCount(), 1);
  } finally {
    frames.close();
    stream.releaseLock();
  }
});

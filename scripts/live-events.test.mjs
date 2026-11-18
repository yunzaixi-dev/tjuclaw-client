import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import ts from 'typescript';
import { onRequest } from '../functions/api/[[path]].js';

// Resolve the client's extensionless Vite imports inside Node.
const source = new URL('../src/', import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, next) {
    return next(context.parentURL?.startsWith(source) && /^\.\.?\//.test(specifier) && !/\.[^/]+$/.test(specifier) ? `${specifier}.ts` : specifier, context);
  },
  load(url, context, next) {
    if (!url.startsWith(source) || !url.endsWith('.ts')) return next(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(readFileSync(new URL(url), 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText };
  },
});
const { followLiveEvents } = await import('../src/lib/live-events.ts');
const { recoverSend } = await import('../src/lib/chat-readback.ts');
const { sendMessage } = await import('../src/lib/library.ts');
hooks.deregister();

const session = 'a'.repeat(32);
const request = '0123456789abcdef0123456789abcdef';
const sse = 'text/event-stream';
const json = 'application/json';
const frame = (version, count, items, extra = {}) => ({ client_request_id: request, version, count, items, ...extra });
const text = (i, value, next, from = 0) => ({ i, kind: 'text', text: value, next, from });
const tool = (i, status = 'running') => ({ i, kind: 'tool', name: 'read', status });
const wire = (data, eol = '\n') => `data: ${JSON.stringify(data)}${eol}${eol}`;

function stream(signal) {
  let controller;
  const body = new ReadableStream({ start(value) { controller = value; } });
  signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
  const encoder = new TextEncoder();
  return {
    response: new Response(body, { headers: { 'content-type': `${sse}; charset=utf-8` } }),
    write: chunk => controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk),
    close: () => controller.close(),
    fail: () => controller.error(new TypeError('connection dropped')),
  };
}

function follow(t, reply, saved) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  // authRequest's existing JSON timeout uses the browser global.
  globalThis.window = globalThis;
  t.after(() => { delete globalThis.window; });
  const calls = [], frames = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    const url = new URL(path, 'https://claw.example');
    const call = { path: url.pathname, accept: new Headers(init.headers).get('accept'), query: Object.fromEntries(url.searchParams), signal: init.signal };
    calls.push(call);
    assert.equal(url.pathname, `/api/sessions/${session}${saved && !url.pathname.endsWith('/live') ? '' : '/live'}`);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.credentials, 'same-origin');
    if (url.pathname.endsWith('/live')) assert.equal(call.query.client_request_id, request);
    return reply(call, calls.length);
  });
const stop = followLiveEvents(session, request, (shown, live) => frames.push({ shown, live }), saved);
  t.after(stop);
  const tick = async ms => { t.mock.timers.tick(ms); await setImmediate(); };
  return { calls, frames, stop, tick };
}

for (const lostResponse of [true, false]) {
  test(lostResponse ? 'a proxy 502 with the model error name still reads back a saved POST' : 'a forwarded model 502 is an explicit refusal', async t => {
    globalThis.window = globalThis;
    t.after(() => { delete globalThis.window; });
    const at = '2026-11-18T12:00:00Z';
    const content = '回复已保存';
    const requests = [];
    let saved;
    t.mock.method(globalThis, 'fetch', async (path, init) => {
      if (typeof path === 'string') return onRequest({ request: new Request(new URL(path, 'https://claw.example'), init) });
      const method = init.method;
      requests.push(method);
      if (method === 'POST') {
        if (!lostResponse) return Response.json({ error: { id: 'upstream_unavailable' } }, { status: 502 });
        const posted = await new Response(init.body).json();
        saved = { id: session, entry_id: 'b'.repeat(32), created_at: at, updated_at: at, messages: [
          { role: 'user', content: posted.content, client_request_id: posted.client_request_id, created_at: at },
          { role: 'assistant', content: '已完成', created_at: at },
        ] };
        throw new TypeError('lost upstream response after saving');
      }
      return Response.json({ session: saved });
    });
    const signal = new AbortController().signal;
    let cause;
    await assert.rejects(sendMessage(session, content, request, signal), error => {
      cause = error;
      return error.status === 502 && error.body.error.id === 'upstream_unavailable';
    });
    assert.deepEqual(await recoverSend(cause, session, request, content, signal, () => true), lostResponse ? saved : 'refused');
    assert.deepEqual(requests, lostResponse ? ['POST', 'GET'] : ['POST']);
  });
}

test('repeated short SSE connections back off without delaying the first resume', async t => {
  t.mock.method(performance, 'now', () => Date.now());
  const { calls, stop, tick } = follow(t, ({ signal }, index) => index <= 6
    ? new Response(wire(frame(index, 1, [text(0, '字'.repeat(index), 3 * index)])), { headers: { 'content-type': sse } })
    : stream(signal).response);
  await tick(0);
  assert.equal(calls.length, 2);
  for (const delay of [250, 500, 1000, 1000]) {
    const count = calls.length;
    await tick(delay - 1);
    assert.equal(calls.length, count);
    await tick(1);
    assert.equal(calls.length, count + 1);
    assert.deepEqual(calls.at(-1).query, { version: String(count), tail: '0', at: String(3 * count), client_request_id: request });
  }
  stop();
  await tick(1000);
  assert.equal(calls.length, 6);
});

test('delivers separated SSE frames before EOF and reconnects with the applied byte cursor', async t => {
  const connections = [];
  const { calls, frames, stop, tick } = follow(t, ({ signal }) => {
    const connection = stream(signal);
    connections.push(connection);
    return connection.response;
  });
  await tick(300);
  assert.equal(calls[0]?.accept, sse);
  const first = connections[0];
  first.write(': pulse\r\n\r\n');
  first.write(wire(frame(9, 1, [text(0, '是旧回复', 12)], { client_request_id: 'stale' })));
  const bytes = new TextEncoder().encode(wire(frame(10, 1, [text(0, '先', 3)]), '\r\n'));
  const cut = bytes.findIndex(byte => byte > 127) + 1;
  first.write(bytes.subarray(0, cut));
  await setImmediate();
  assert.deepEqual(frames.filter(({ shown }) => shown), []);
  first.write(bytes.subarray(cut, -1));
  await setImmediate();
  assert.deepEqual(frames.filter(({ shown }) => shown), []);
  first.write(bytes.subarray(-1));
  await setImmediate();
  assert.equal(frames.at(-1)?.shown?.[0].text, '先');
  first.write(wire(frame(11, 2, [text(0, '看', 6, 3), tool(1)])));
  await setImmediate();
  assert.deepEqual(frames.at(-1)?.shown?.map(item => item.text || item.name), ['先看', 'read']);
  assert.equal(calls.length, 1);

  first.close();
  await setImmediate();
  assert.equal(calls[1]?.accept, sse);
  assert.deepEqual(calls[1]?.query, { version: '11', tail: '2', at: '0', client_request_id: request });
  connections[1].write(wire(frame(12, 3, [tool(1, 'done'), text(2, '答案', 6)])));
  await setImmediate();
  assert.deepEqual(frames.at(-1)?.shown?.map(item => item.text || item.status), ['先看', 'done', '答案']);
  stop();
  assert.equal(calls[1].signal.aborted, true);
  await tick(30000);
  assert.equal(calls.length, 2);
});

test('a legacy JSON response itself is the first poll, and polling then resumes from its cursor', async t => {
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 1) return Response.json(frame(1, 1, [tool(0)]));
    if (index === 2) return Response.json(frame(2, 2, [tool(0, 'done'), text(1, '完', 3)]));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await tick(300);
  assert.deepEqual(calls.slice(0, 2).map(call => call.accept), [sse, json]);
  assert.deepEqual(calls[1].query, { version: '1', tail: '1', at: '0', client_request_id: request });
  assert.deepEqual(frames.at(-1)?.shown?.map(item => item.text || item.status), ['done', '完']);
});

test('a stalled SSE body or an early connection failure falls back without a POST', async t => {
  for (const reason of ['buffering', 'early-error']) {
    await t.test(reason, async sub => {
      const { calls, frames, tick } = follow(sub, ({ signal }, index) => {
        if (index === 1) {
          if (reason === 'early-error') throw new TypeError('network failed');
          return stream(signal).response;
        }
        if (index === 2) return Response.json(frame(1, 1, [text(0, '继续', 6)]));
        return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
      });
      await tick(300);
      assert.deepEqual(calls.map(call => call.accept), reason === 'buffering' ? [sse] : [sse, json, json]);
      if (reason === 'buffering') {
        await tick(2000);
        assert.equal(calls.length, 1);
        await tick(10000);
      }
      assert.equal(calls[0].signal.aborted, true);
      assert.equal(calls[1]?.accept, json);
      assert.equal(frames.at(-1)?.shown?.[0].text, '继续');
    });
  }
});

test('a transport going silent after a heartbeat falls back from the last applied byte cursor', async t => {
  let connection;
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 1) {
      connection = stream(signal);
      return connection.response;
    }
    if (index === 2) return Response.json(frame(4, 1, [text(0, '案', 6, 3)]));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await tick(300);
  connection.write(wire(frame(3, 1, [text(0, '答', 3)])));
  await tick(0);
  await tick(3000);
  connection.write(': heartbeat\n\n');
  await tick(0);
  await tick(11999);
  assert.equal(calls.length, 1);
  await tick(1);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1]?.accept, json);
  assert.deepEqual(calls[1].query, { version: '3', tail: '0', at: '3', client_request_id: request });
  assert.deepEqual(frames.map(({ shown }) => shown?.[0].text), ['答', '答案']);
});

test('a proxy closing immediately after the opening comment falls back to JSON', async t => {
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 1) return new Response(': connected\n\n', { headers: { 'content-type': sse } });
    if (index === 2) return Response.json(frame(1, 1, [tool(0)]));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await tick(300);
  assert.deepEqual(calls.slice(0, 2).map(call => call.accept), [sse, json]);
  assert.equal(frames.at(-1)?.shown?.[0].name, 'read');
});

test('a first frame that keeps trickling in still falls back by the progress deadline', async t => {
  let connection;
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 2) return Response.json(frame(1, 1, [text(0, '正文', 6)]));
    if (index > 2) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    connection = stream(signal);
    return connection.response;
  });
  await tick(300);
  const payload = wire(frame(1, 1, [text(0, '正文', 6)]));
  connection.write(payload.slice(0, 10));
  await tick(0);
  await tick(3500);
  connection.write(payload.slice(10, 20));
  await tick(0);
  await tick(2000);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1]?.accept, json);
  assert.equal(frames.at(-1)?.shown?.[0].text, '正文');
});

test('invalid, foreign, and duplicate frames neither update the screen nor postpone fallback', async t => {
  let connection;
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 1) { connection = stream(signal); return connection.response; }
    if (index === 2) return Response.json(frame(2, 1, [text(0, '案', 6, 3)]));
    return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  await tick(300);
  connection.write(wire(frame(1, 1, [text(0, '答', 3)])));
  await tick(0);
  await tick(3000);
  connection.write('data: bad-json\n\n');
  connection.write(wire(frame(2, 0, [], { client_request_id: 'wrong', stage: { id: 'thinking' } })));
  connection.write(wire(frame(2, 0, [], { items: 'broken', stage: { id: 'thinking' } })));
  connection.write(wire(frame(1, 1, [text(0, '旧', 3)], { stage: { id: 'thinking' } })));
  await tick(0);
  assert.deepEqual(frames.map(({ shown }) => shown?.[0].text), ['答']);
  await tick(9000);
  assert.equal(calls[1]?.accept, json);
  assert.deepEqual(frames.map(({ shown }) => shown?.[0].text), ['答', '答案']);
});

test('opens immediately and keeps a healthy SSE connection through a quiet model wait', async t => {
  let connection;
  const { calls, frames, tick } = follow(t, ({ signal }) => {
    connection = stream(signal);
    return connection.response;
  });
  await tick(0);
  assert.equal(calls[0]?.accept, sse, 'do not delay the first stream request');
  connection.write(': connected\n\n');
  connection.write(wire(frame(1, 0, [], { stage: { id: 'model' } })));
  await tick(0);
  await tick(8000);
  assert.equal(calls.length, 1, 'the client must outlive the server heartbeat interval');
  connection.write(': heartbeat\n\n');
  await tick(0);
  await tick(8000);
  connection.write(wire(frame(2, 1, [text(0, '答案', 6)], { stage: { id: 'writing' } })));
  await tick(0);
  assert.equal(calls.length, 1);
  assert.equal(frames.at(-1)?.shown?.[0].text, '答案');
});

test('a broken body immediately reconnects SSE from the last fully applied UTF-8 offset', async t => {
  const connections = [];
  const { calls, frames, tick } = follow(t, ({ signal }) => {
    const connection = stream(signal);
    connections.push(connection);
    return connection.response;
  });
  await tick(300);
  connections[0].write(wire(frame(1, 1, [text(0, '先🐱', 7)])));
  await tick(0);
  connections[0].write('data: {"version":2');
  await tick(0);
  connections[0].fail();
  await tick(0);
  assert.equal(calls[1]?.accept, sse);
  assert.deepEqual(calls[1]?.query, { version: '1', tail: '0', at: '7', client_request_id: request });
  connections[1].write(wire(frame(2, 1, [text(0, '看', 10, 7)])));
  await tick(0);
  assert.deepEqual(frames.map(({ shown }) => shown?.[0].text), ['先🐱', '先🐱看']);
});

test('fallback reads the saved answer without waiting for the live GET or crossing the next user message', async t => {
  const date = '2026-11-18T12:00:00Z';
  const user = (id, content) => ({ role: 'user', content, client_request_id: id, created_at: date });
  const assistant = content => ({ role: 'assistant', content, created_at: date });
  const ask = user(request, '本轮问题');
  const prev = [user('f'.repeat(32), '上一轮'), assistant('旧正文')];
  const next = [user('e'.repeat(32), '下一轮'), assistant('后续正文')];
  const saved = [];
  let reads = 0;
  const { calls, tick } = follow(t, ({ signal, path }, index) => {
    if (index === 1) return stream(signal).response;
    if (path.endsWith('/live')) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    reads++;
    const messages = reads === 1 ? [...prev, ask, ...next] : [...prev, ask, assistant('本轮正文'), ...next];
    return Response.json({ session: { id: session, entry_id: 'b'.repeat(32), created_at: date, updated_at: date, messages } });
  }, { content: ask.content, onReply: value => saved.push(value) });
  await tick(0);
  assert.equal(reads, 1);
  assert.deepEqual(saved, []);
  await tick(3000);
  assert.equal(reads, 2);
  assert.deepEqual(saved[0]?.messages, [...prev, ask, assistant('本轮正文')]);
  assert.equal(calls[0].signal.aborted, true);
  await tick(30000);
  assert.equal(reads, 2);
});

test('an unjoinable delta falls back without a cursor and retains the task timeline until the full snapshot', async t => {
  const connections = [];
  const { calls, frames, tick } = follow(t, ({ signal }, index) => {
    if (index === 2) return Response.json(frame(3, 2, [tool(0, 'done'), text(1, '答案', 6)]));
    if (index > 2) return new Promise((_, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    const connection = stream(signal);
    connections.push(connection);
    return connection.response;
  });
  await tick(300);
  assert.equal(calls[0]?.accept, sse);
  connections[0].write(wire(frame(1, 2, [tool(0), text(1, '答', 3)])));
  connections[0].write(wire(frame(2, 2, [text(1, '案', 12, 9)])));
  await setImmediate();
  assert.deepEqual(frames.flatMap(({ shown }) => shown ? [shown[1].text] : []), ['答', '答案']);
  assert.equal(calls[0].signal.aborted, true);
  assert.equal(calls[1]?.accept, json);
  assert.deepEqual(calls[1]?.query, { client_request_id: request });
  assert.deepEqual(frames.at(-1)?.shown?.map(item => item.text || item.status), ['done', '答案']);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { setImmediate } from 'node:timers/promises';
import test from 'node:test';
import ts from 'typescript';

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
hooks.deregister();

const session = 'abc';
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
  };
}

function follow(t, reply) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // authRequest's existing JSON timeout uses the browser global.
  globalThis.window = globalThis;
  t.after(() => { delete globalThis.window; });
  const calls = [], frames = [];
  t.mock.method(globalThis, 'fetch', async (path, init) => {
    const url = new URL(path, 'https://claw.example');
    const call = { accept: new Headers(init.headers).get('accept'), query: Object.fromEntries(url.searchParams), signal: init.signal };
    calls.push(call);
    assert.equal(path.split('?')[0], `/api/sessions/${session}/live`);
    assert.equal(init.method ?? 'GET', 'GET');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(call.query.client_request_id, request);
    return reply(call, calls.length);
  });
  const stop = followLiveEvents(session, request, (shown, live) => frames.push({ shown, live }));
  t.after(stop);
  const tick = async ms => { t.mock.timers.tick(ms); await setImmediate(); };
  return { calls, frames, stop, tick };
}

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
  assert.equal(calls.length, 1);
  await tick(1500);
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

test('heartbeats keep the stream alive and a later stall passes its cursor to JSON polling', async t => {
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
  await tick(8000);
  connection.write(': pulse\n\n');
  await tick(0);
  await tick(8000);
  assert.equal(calls.length, 1);
  await tick(2500);
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

test('actively arriving partial bytes do not time out a large SSE frame', async t => {
  let connection;
  const { calls, frames, tick } = follow(t, ({ signal }) => {
    connection = stream(signal);
    return connection.response;
  });
  await tick(300);
  const payload = wire(frame(1, 1, [text(0, '正文', 6)]));
  connection.write(payload.slice(0, 10));
  await tick(0);
  await tick(8500);
  connection.write(payload.slice(10, 20));
  await tick(0);
  await tick(3000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].signal.aborted, false);
  connection.write(payload.slice(20));
  await tick(0);
  assert.equal(frames.at(-1)?.shown?.[0].text, '正文');
});

test('an unjoinable delta reconnects without a cursor and retains the task timeline until the full snapshot', async t => {
  const connections = [];
  const { calls, frames, tick } = follow(t, ({ signal }) => {
    const connection = stream(signal);
    connections.push(connection);
    return connection.response;
  });
  await tick(300);
  assert.equal(calls[0]?.accept, sse);
  connections[0].write(wire(frame(1, 2, [tool(0), text(1, '答', 3)])));
  connections[0].write(wire(frame(2, 2, [text(1, '案', 12, 9)])));
  await setImmediate();
  assert.deepEqual(frames.flatMap(({ shown }) => shown ? [shown[1].text] : []), ['答']);
  assert.equal(calls[0].signal.aborted, true);
  await tick(1500);
  assert.equal(calls[1]?.accept, sse);
  assert.deepEqual(calls[1]?.query, { client_request_id: request });
  connections[1].write(wire(frame(3, 2, [tool(0, 'done'), text(1, '答案', 6)])));
  await setImmediate();
  assert.deepEqual(frames.at(-1)?.shown?.map(item => item.text || item.status), ['done', '答案']);
});

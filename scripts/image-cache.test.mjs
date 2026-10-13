import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const delivery = ts.transpileModule(await readFile(new URL('../src/lib/file-delivery.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const deliveryURL = `data:text/javascript;base64,${Buffer.from(delivery).toString('base64')}`;
const noteFiles = ts.transpileModule(await readFile(new URL('../src/lib/note-files.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const noteFilesURL = `data:text/javascript;base64,${Buffer.from(noteFiles).toString('base64')}`;
const source = ts.transpileModule((await readFile(new URL('../src/lib/image-cache.ts', import.meta.url), 'utf8'))
  .replace("import('./file-delivery')", `import('${deliveryURL}')`)
  .replace("from './note-files'", `from '${noteFilesURL}'`), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const { ImageCache, markdownImageCache } = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const resource = (src, bytes = 2) => ({ src, width: 480, height: 300, bytes });

test('simultaneous references and later note opens share one completed request', async () => {
  let loads = 0;
  const cache = new ImageCache({ load: async src => { loads++; return resource(src); }, revoke() {} });
  const a = cache.acquire('image?v=1'), b = cache.acquire('image?v=1');
  assert.equal(a.ready, b.ready);
  await a.ready;
  a.release(); b.release();
  const later = cache.acquire('image?v=1');
  assert.equal((await later.ready).width, 480);
  assert.equal(loads, 1);
  later.release();
  const updated = cache.acquire('image?v=2');
  await updated.ready;
  assert.equal(loads, 2);
  updated.release();
});

test('LRU eviction never revokes an image held by a mounted view', async () => {
  const revoked = [];
  const cache = new ImageCache({ maxBytes: 3, load: async src => resource(src), revoke: value => revoked.push(value.src) });
  const a = cache.acquire('a'), b = cache.acquire('b');
  await Promise.all([a.ready, b.ready]);
  assert.deepEqual(revoked, []);
  a.release();
  assert.deepEqual(revoked, ['a']);
  assert.equal(cache.peek('a'), undefined);
  assert.equal(cache.peek('b').src, 'b');
  b.release();
  b.release();
  assert.deepEqual(revoked, ['a']);
});

test('failed loads do not poison the next explicit retry', async () => {
  let calls = 0;
  const cache = new ImageCache({ load: async src => {
    if (++calls === 1) throw new Error('offline');
    return resource(src);
  }, revoke() {} });
  const failed = cache.acquire('a');
  await assert.rejects(failed.ready, /offline/);
  failed.release();
  const retried = cache.acquire('a');
  await retried.ready;
  retried.release();
  assert.equal(calls, 2);
});

test('switching identity cancels in-flight work and cannot repopulate the next cache', async () => {
  const completions = [], revoked = [], signals = [];
  const cache = new ImageCache({ load: (src, signal) => {
    signals.push(signal);
    return new Promise(resolve => completions.push(resolve));
  }, revoke: value => revoked.push(value.src) });
  cache.open('owner-a');
  const a = cache.acquire('/private');
  const rejected = assert.rejects(a.ready, { name: 'AbortError' });
  await Promise.resolve();
  cache.open('owner-b');
  assert.equal(signals[0].aborted, true);
  const b = cache.acquire('/private');
  await Promise.resolve();
  completions[0](resource('blob:old'));
  await rejected;
  assert.equal(cache.peek('/private'), undefined);
  completions[1](resource('blob:new'));
  await b.ready;
  assert.equal(cache.peek('/private').src, 'blob:new');
  assert.deepEqual(revoked, ['blob:old']);
  a.release(); b.release();
  cache.clear();
  assert.deepEqual(revoked, ['blob:old', 'blob:new']);
});

test('expired images refresh without revoking the previous mounted lease', async () => {
  let loads = 0;
  const revoked = [];
  const cache = new ImageCache({ maxAge: -1, load: async () => resource(`blob:${++loads}`), revoke: value => revoked.push(value.src) });
  const first = cache.acquire('url');
  await first.ready;
  const next = cache.acquire('url');
  await next.ready;
  assert.equal(loads, 2);
  assert.deepEqual(revoked, []);
  first.release();
  assert.deepEqual(revoked, ['blob:1']);
  next.release();
  cache.clear();
  assert.deepEqual(revoked, ['blob:1', 'blob:2']);
});

test('native Markdown images authenticate through the API on an opaque Tauri origin', async () => {
  const originals = new Map(['location', 'fetch', 'Image', '__TAURI_INTERNALS__'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    Object.defineProperty(globalThis, 'location', { configurable: true, value: new URL('tauri://localhost/workspace') });
    Object.defineProperty(globalThis, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    globalThis.Image = class {
      naturalWidth = 1;
      naturalHeight = 1;
      set src(_value) { queueMicrotask(() => this.onload?.()); }
      decode() { return Promise.resolve(); }
      removeAttribute() {}
    };
    let requests = 0;
    globalThis.fetch = async (url, options) => {
      requests++;
      assert.equal(new URL(url).protocol, 'tauri:');
      assert.equal(new URL(url).searchParams.has('delivery'), false);
      assert.equal(options.credentials, 'same-origin');
      return new Response('synthetic png', { headers: { 'Content-Type': 'image/png' } });
    };
    markdownImageCache.open('synthetic-owner');
    const lease = markdownImageCache.acquire(`/api/entries/${'a'.repeat(32)}/file?v=revision`);
    const image = await lease.ready;
    assert.equal(image.width, 1);
    assert.match(image.src, /^blob:/);
    assert.equal(requests, 1);
    lease.release();
  } finally {
    markdownImageCache.clear();
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
});

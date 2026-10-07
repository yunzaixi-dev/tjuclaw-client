import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/library.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText
  .replace(/import \{ authRequest, AuthError \} from '\.\/auth';/,
    'const authRequest = async () => globalThis.__productModelTestResponse; class AuthError extends Error { constructor(status) { super(); this.status = status; } }')
  .replace(/export \{[^}]+\} from '\.\/quota-format\.ts';/, '');
const library = await import(`data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`);

test('model display keeps canonical routing IDs for product and custom models', () => {
  for (const name of ['deepseek-flash', 'gemini-3.8-flash-tiered', 'claude-opus-4-7-thinking', 'gpt-6.1-sol']) {
    assert.equal(library.modelDisplayName({ source: 'product', name }), name);
    assert.equal(library.modelDisplayName({ source: 'custom', name }), name);
  }
  assert.equal(library.modelDisplayName({ source: 'none' }), '未配置');
});

test('model status accepts explicit unlimited and legacy quota, but rejects forged nonboolean flags', async () => {
  const model = { configured: false, source: 'product', name: 'deepseek-flash', quota: { limit: 0, used: 0, remaining: 0 }, windows: [] };
  for (const flag of [undefined, false, true]) {
    globalThis.__productModelTestResponse = { model: { ...model, quota: { ...model.quota, ...(flag === undefined ? {} : { unlimited: flag }) } } };
    const status = await library.getModel();
    assert.equal(status.quota.unlimited, flag);
  }
  for (const unlimited of ['true', 1, null, {}]) {
    globalThis.__productModelTestResponse = { model: { ...model, quota: { ...model.quota, unlimited } } };
    await assert.rejects(library.getModel(), error => error.status === 503);
  }
  delete globalThis.__productModelTestResponse;
});

test('only server-reported unlimited suppresses an exhausted rolling window', () => {
  const window = { id: '7d', limit: 200, used: 200, remaining: 0 };
  assert.equal(library.exhaustedQuotaWindow({ windows: [window] }), window);
  assert.equal(library.exhaustedQuotaWindow({ windows: [window], quota: { unlimited: false } }), window);
  assert.equal(library.exhaustedQuotaWindow({ windows: [window], quota: { unlimited: true } }), null);
});

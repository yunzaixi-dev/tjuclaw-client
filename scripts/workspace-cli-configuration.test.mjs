import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const component = ts.transpileModule(await readFile(new URL('../src/components/workspace-cli-configuration.tsx', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
}).outputText
  .replace(/from ["']react["']/g, `from ${JSON.stringify(import.meta.resolve('react'))}`)
  .replace(/from ["']react\/jsx-runtime["']/g, `from ${JSON.stringify(import.meta.resolve('react/jsx-runtime'))}`)
  .replace(/from ["']\.\/ui\/button["']/g, `from ${JSON.stringify(dataURL('export function Button() {}'))}`);
const { parseWorkspaceConfigurationDraft: parse } = await import(dataURL(component));
const endpoint = { name: 'campus-model', base_url: 'https://model.example/v1/', model: 'test-model' };

test('declarative config trims metadata without retaining raw credentials or native execution fields', () => {
  assert.deepEqual(parse([{ ...endpoint, name: ' campus-model ', api_key: 'ignored', root: '/ignored', env: { KEY: 'ignored' } }], '\n /local/test-plugin.ts \n'), {
    endpoints: [{ name: 'campus-model', base_url: 'https://model.example/v1/', model: 'test-model' }],
    plugins: ['/local/test-plugin.ts'],
  });
  assert.deepEqual(parse([], ''), { endpoints: [], plugins: [] });
});

test('endpoint-only drafts omit plugins instead of reconstructing current native references', () => {
  const draft = parse([endpoint]);
  assert.deepEqual(draft, { endpoints: [{ name: 'campus-model', base_url: 'https://model.example/v1/', model: 'test-model' }] });
  assert.equal(Object.hasOwn(draft, 'plugins'), false);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(draft)), 'plugins'), false);
  // Both omission and [] are no-ops in native merge; actual CLI transaction
  // semantics are covered by the native/CLI worker, not this parser test.
  assert.deepEqual(parse([], '').plugins, []);
  assert.deepEqual(parse([], '/local/plugin.ts').plugins, ['/local/plugin.ts']);
});

test('validated endpoint URLs retain exact trailing slashes and spelling for native current-key comparison', () => {
  for (const base_url of ['https://model.example/v1/', 'https://MODEL.example/v1', 'https://model.example:443/v1', 'https://model.example/v1/%2f']) {
    assert.equal(parse([{ ...endpoint, base_url }]).endpoints[0].base_url, base_url);
  }
});

test('model addresses cannot carry URL credentials, secret query strings, fragments, or non-HTTP schemes', () => {
  for (const base_url of [
    'https://user:secret@model.example/v1', 'https://model.example/v1?api_key=secret',
    'https://model.example/v1#secret', 'file:///tmp/key', 'javascript:alert(1)', 'not-a-url',
    'https://model.exa\nmple/v1', 'https://model.example/v1/\u202E',
  ]) assert.throws(() => parse([{ ...endpoint, base_url }], ''), /地址|密钥/);
  // Host-side model endpoints may deliberately use a loopback service. The page
  // only records metadata and never requests this address.
  assert.equal(parse([{ ...endpoint, base_url: 'http://127.0.0.1:9999/v1' }], '').endpoints[0].base_url, 'http://127.0.0.1:9999/v1');
});

test('invalid endpoint names, duplicate entries, empty models and excessive collections fail before native calls', () => {
  for (const name of ['', '中文名', '--model', 'name with spaces', 'name\nhidden', 'x'.repeat(81)]) {
    assert.throws(() => parse([{ ...endpoint, name }], ''), /端点名称/);
  }
  assert.throws(() => parse([endpoint, endpoint], ''), /重复/);
  assert.throws(() => parse([{ ...endpoint, model: ' ' }], ''), /模型名称/);
  assert.throws(() => parse([{ ...endpoint, model: 'model\u0000key' }], ''), /模型名称/);
  assert.throws(() => parse([{ ...endpoint, model: 'model\u202Ename' }], ''), /模型名称/);
  assert.throws(() => parse(Array.from({ length: 17 }, (_, index) => ({ ...endpoint, name: `model-${index}` })), ''), /16/);
});

test('plugin refs accept only absolute local paths and enforce UTF8 byte and collection limits', () => {
  assert.deepEqual(parse([], '/local/plugin.ts\nC:\\plugins\\extension.ts\nC:/plugins/extension.ts').plugins, [
    '/local/plugin.ts', 'C:\\plugins\\extension.ts', 'C:/plugins/extension.ts',
  ]);
  assert.equal(parse([], '/' + 'x'.repeat(511)).plugins[0].length, 512);
  assert.equal(parse([], '/' + '界'.repeat(170)).plugins[0].length, 171);
  for (const refs of [
    'KEY=secret', '--execute', '/local/plugin.ts\n/local/plugin.ts', '/local/plugin\u0000secret', 'rm -rf /',
    'npm:test-plugin@1', '~/plugin.ts', './plugin.ts', 'plugin.ts', 'C:plugin.ts', 'file:///tmp/plugin.ts', 'https://git.example/plugin with spaces',
    '//host/share/plugin.ts', '\\\\host\\share\\extension.ts', '\\\\?\\C:\\plugin.ts', '\\\\.\\C:\\plugin.ts',
    'https://git.example/plugin', 'http://git.example/plugin', '/local/plugin\u202E.ts', '/KEY=secret/plugin.ts',
    'https://user:secret@git.example/plugin', 'https://git.example/plugin?token',
    'https://git.example/plugin#secret', '/' + 'x'.repeat(512), '/' + '界'.repeat(171),
    Array.from({ length: 33 }, (_, index) => `/local/plugin-${index}.ts`).join('\n'),
  ]) assert.throws(() => parse([], refs), /插件引用|凭据/);
});

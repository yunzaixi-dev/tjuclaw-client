import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const trustURL = dataURL(await compile('../src/lib/campus-device-trust.ts'));
const unlockURL = dataURL((await compile('../src/lib/campus-unlock.ts'))
  .replace(/from ['"]\.\/campus-device-trust['"]/, `from ${JSON.stringify(trustURL)}`));
const authURL = dataURL((await compile('../src/lib/auth.ts'))
  .replace(/from ['"]\.\/campus-unlock['"]/, `from ${JSON.stringify(unlockURL)}`));
const { AuthError } = await import(authURL);
const api = await import(dataURL((await compile('../src/lib/workspace-cloud-registration.ts'))
  .replace(/from ['"]\.\/auth['"]/, `from ${JSON.stringify(authURL)}`)));
const savedFetch = globalThis.fetch;
const savedWindow = globalThis.window;
globalThis.window = { setTimeout };
after(() => { globalThis.fetch = savedFetch; globalThis.window = savedWindow; });
const agentId = 'a'.repeat(32);
const libraryId = 'b'.repeat(32);
const cloud = {
  id: '-cloud-workspace', name: '我的云端环境', kind: 'cloud',
  capabilities: [], online: false, last_seen_at: null, created_at: '2026-10-03T10:00:00Z',
};

test('cloud support requires explicit true and cookie-auth same-origin options; missing/nonboolean values fail closed', async () => {
  for (const response of [null, [], {}, { cloud_registration_supported: false }, { cloud_registration_supported: 'true' }, { cloud_registration_supported: 1 }]) {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, '/api/workspaces/registration-options');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.cache, 'no-store');
      assert.equal(init.redirect, 'error');
      assert.equal(init.body, undefined);
      return Response.json(response);
    };
    assert.deepEqual(await api.workspaceRegistrationOptions(), { local_registration_supported: false, cloud_registration_supported: false });
  }
  globalThis.fetch = async () => Response.json({ local_registration_supported: true, cloud_registration_supported: true, model_ready: 'not-proof' });
  assert.deepEqual(await api.workspaceRegistrationOptions(), { local_registration_supported: true, cloud_registration_supported: true });
});

test('options failure stays an error rather than permission and does not register anything', async () => {
  let requests = 0;
  for (const status of [404, 503, 401]) {
    globalThis.fetch = async (_path, init) => {
      requests++;
      assert.equal(init.method, undefined);
      return Response.json({ error: { id: 'unavailable' } }, { status });
    };
    await assert.rejects(api.workspaceRegistrationOptions(), error => error instanceof AuthError && error.status === status);
  }
  assert.equal(requests, 3);
});

test('owner-only library and matching Agent projections retain names/IDs, never bodies or subscribed/unknown-role entries', () => {
  assert.deepEqual(api.ownedCloudLibraries([
    { id: libraryId, name: '自有', role: 'owner', secret: 'discarded' },
    { id: 'c'.repeat(32), name: '订阅', role: 'subscribed' },
    { id: 'd'.repeat(32), name: '未知' },
  ]), [{ id: libraryId, name: '自有' }]);
  assert.deepEqual(api.cloudAgentOptions([
    { id: agentId, library_id: libraryId, title: '我的 Agent', kind: 'agent', body: 'private-agent-body' },
    { id: 'e'.repeat(32), library_id: libraryId, title: '笔记', kind: 'note' },
    { id: 'f'.repeat(32), library_id: 'c'.repeat(32), title: '外部 Agent', kind: 'agent' },
  ], libraryId), [{ id: agentId, title: '我的 Agent' }]);
  assert.deepEqual(api.ownedCloudLibraries([]), []);
  assert.deepEqual(api.cloudAgentOptions([], libraryId), []);
});

test('cloud registration sends only the exact owner-Agent binding and explicit empty or Pi capabilities, with no token retained', async () => {
  for (const capabilities of [[], ['pi.prompt']]) {
    globalThis.fetch = async (path, init) => {
      assert.equal(path, '/api/workspaces');
      assert.equal(init.method, 'POST');
      assert.equal(init.credentials, 'same-origin');
      assert.equal(init.headers.get('Content-Type'), 'application/json');
      assert.deepEqual(JSON.parse(init.body), { name: cloud.name, kind: 'cloud', capabilities, agent_entry_id: agentId });
      return Response.json({ workspace: { ...cloud, capabilities, body: 'secret-body', api_key: 'secret-key', owner: 'private-owner' }, extra_secret: 'discard-me' }, { status: 201 });
    };
    assert.deepEqual(await api.registerCloudWorkspace({ name: ` ${cloud.name} `, agent_entry_id: agentId, capabilities, owner: 'ignored', command: 'ignored', library_id: 'ignored' }), { ...cloud, capabilities });
  }
});

test('invalid cloud inputs fail before any POST; workspace IDs are not Agent IDs and non-Pi grants are forbidden', async () => {
  let requests = 0;
  globalThis.fetch = async () => { requests++; return Response.json({ workspace: cloud }, { status: 201 }); };
  for (const input of [
    { name: '', agent_entry_id: agentId, capabilities: [] },
    { name: '名'.repeat(81), agent_entry_id: agentId, capabilities: [] },
    ...['', 'A'.repeat(32), '../agent', '-' + 'a'.repeat(42), 'a'.repeat(31)].map(agent_entry_id => ({ name: '环境', agent_entry_id, capabilities: [] })),
    { name: '环境', agent_entry_id: agentId, capabilities: ['mcp.call'] },
    { name: '环境', agent_entry_id: agentId, capabilities: undefined },
  ]) await assert.rejects(api.registerCloudWorkspace(input), error => error instanceof AuthError && error.status === 400);
  assert.equal(requests, 0);
});

test('cloud response rejects wrong kind, connector token presence and malformed fields without retaining raw bodies', async () => {
  for (const response of [
    null, {}, { workspace: { ...cloud, kind: 'local' } },
    { workspace: cloud, connection_token: 'never-display-this' },
    { workspace: cloud, connection_token: null },
    { workspace: { ...cloud, connection_token: 'nested-token' } },
    { workspace: { ...cloud, online: 'true' } },
    { workspace: { ...cloud, capabilities: ['mcp.call'] } },
    { workspace: { ...cloud, id: '../escape' } },
    { workspace: { ...cloud, created_at: 'invalid' } },
    { workspace: { ...cloud, last_seen_at: 'invalid' } },
  ]) {
    globalThis.fetch = async () => Response.json(response, { status: 201 });
    await assert.rejects(api.registerCloudWorkspace({ name: cloud.name, agent_entry_id: agentId, capabilities: [] }), error => error instanceof AuthError && error.status === 502);
  }
});

test('authoritative foreign/revoked Agent failures and request aborts propagate without retries', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: { id: 'agent_not_found' } }, { status: 404 });
  };
  await assert.rejects(api.registerCloudWorkspace({ name: cloud.name, agent_entry_id: agentId, capabilities: [] }), error => error.status === 404);
  assert.equal(requests, 1);
  const controller = new AbortController();
  globalThis.fetch = (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const registering = api.registerCloudWorkspace({ name: cloud.name, agent_entry_id: agentId, capabilities: [] }, controller.signal);
  controller.abort();
  await assert.rejects(registering, error => error.name === 'AbortError');
});

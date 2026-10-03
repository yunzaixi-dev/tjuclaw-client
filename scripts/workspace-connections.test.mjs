import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { after, test } from 'node:test';
import ts from 'typescript';

const compile = async path => ts.transpileModule(await readFile(new URL(path, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const dataURL = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
const authURL = dataURL(await compile('../src/lib/auth.ts'));
const { AuthError } = await import(authURL);
const api = await import(dataURL((await compile('../src/lib/workspace-connections.ts'))
  .replace(/from ['"]\.\/auth['"]/, `from ${JSON.stringify(authURL)}`)));
const savedFetch = globalThis.fetch;
const savedWindow = globalThis.window;
globalThis.window = { setTimeout };
after(() => { globalThis.fetch = savedFetch; globalThis.window = savedWindow; });
const workspace = {
  id: '0123456789abcdef0123456789abcdef', name: '我的系统环境', kind: 'local',
  capabilities: [], online: false, last_seen_at: null, created_at: '2026-10-03T10:00:00Z',
};

test('list uses same-origin cookie transport and selects only public environment fields', async () => {
  globalThis.fetch = async (path, init) => {
    assert.equal(path, '/api/workspaces');
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    assert.equal(init.headers.get('Accept'), 'application/json');
    assert.equal(init.headers.get('Authorization'), null);
    assert.equal(init.body, undefined);
    return Response.json({ workspaces: [{ ...workspace, owner: 'private-owner', connection_token: 'never-keep-this' }] });
  };
  assert.deepEqual(await api.listSystemWorkspaces(), [workspace]);
});

test('registration defaults can send explicit empty permissions and never include identity or commands', async () => {
  let requests = 0;
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, '/api/workspaces');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers.get('Content-Type'), 'application/json');
    assert.deepEqual(JSON.parse(init.body), { name: workspace.name, kind: 'local', capabilities: [] });
    return Response.json({ workspace, connection_token: 'one-time-test-token' }, { status: 201 });
  };
  const result = await api.registerSystemWorkspace({
    name: `  ${workspace.name}  `, kind: 'local', capabilities: [],
    owner: 'ignored', executable: '/bin/sh', url: 'https://invalid.example',
  });
  assert.equal(result.connection_token, 'one-time-test-token');
  assert.deepEqual(result.workspace, workspace);
  assert.equal(requests, 1);
});

test('allowlist is explicit, deduplicated, and invalid inputs fail before sending', async () => {
  let requests = 0;
  globalThis.fetch = async (_path, init) => {
    requests++;
    assert.deepEqual(JSON.parse(init.body).capabilities, ['pi.prompt', 'mcp.call']);
    return Response.json({ workspace: { ...workspace, capabilities: ['pi.prompt', 'mcp.call'] }, connection_token: 'test-token' });
  };
  await api.registerSystemWorkspace({ name: '环境', kind: 'local', capabilities: ['pi.prompt', 'pi.prompt', 'mcp.call'] });
  for (const input of [
    { name: ' ', kind: 'local', capabilities: [] },
    { name: '名'.repeat(81), kind: 'local', capabilities: [] },
    { name: '环境', kind: 'docker', capabilities: [] },
    { name: '环境', kind: 'cloud', capabilities: [] },
    { name: '环境', kind: 'local', capabilities: ['shell.exec'] },
  ]) await assert.rejects(api.registerSystemWorkspace(input), error => error instanceof AuthError && error.status === 400);
  assert.equal(requests, 1);
});

test('managed cloud list records remain visible but cannot use the local token-registration contract', async () => {
  const cloud = { ...workspace, kind: 'cloud' };
  globalThis.fetch = async () => Response.json({ workspaces: [cloud] });
  assert.deepEqual(await api.listSystemWorkspaces(), [cloud]);
  globalThis.fetch = async () => Response.json({ workspace: cloud });
  await assert.rejects(api.registerSystemWorkspace({ name: '环境', kind: 'local', capabilities: [] }), error => error.status === 502);
  globalThis.fetch = async () => Response.json({ workspace: cloud, connection_token: 'unexpected-token' });
  await assert.rejects(api.registerSystemWorkspace({ name: '环境', kind: 'local', capabilities: [] }), error => error.status === 502);
});

test('delete binds an opaque ID, has no body, and propagates revocation failures', async () => {
  let requests = 0;
  globalThis.fetch = async (path, init) => {
    requests++;
    assert.equal(path, `/api/workspaces/${workspace.id}`);
    assert.equal(init.method, 'DELETE');
    assert.equal(init.body, undefined);
    return new Response(null, { status: 204 });
  };
  await api.deleteSystemWorkspace(workspace.id);
  for (const id of ['../escape', 'bad?id=x', 'bad#token', '', 'x'.repeat(129)]) {
    await assert.rejects(api.deleteSystemWorkspace(id), error => error.status === 400);
  }
  assert.equal(requests, 1);
  globalThis.fetch = async () => Response.json({ error: { id: 'workspace_not_found' } }, { status: 404 });
  await assert.rejects(api.deleteSystemWorkspace(workspace.id), error => error.status === 404);
});

test('43-character server workspace IDs with dash or underscore prefixes survive list, registration and revocation', async () => {
  for (const firstByte of [0xf8, 0xfc]) {
    const bytes = Buffer.alloc(32);
    bytes[0] = firstByte;
    const id = bytes.toString('base64url');
    assert.equal(id.length, 43);
    assert.match(id, /^[-_]/);
    const prefixed = { ...workspace, id };
    globalThis.fetch = async () => Response.json({ workspaces: [prefixed] });
    assert.equal((await api.listSystemWorkspaces())[0].id, id);
    globalThis.fetch = async () => Response.json({ workspace: prefixed, connection_token: 'test-prefixed-id-token' }, { status: 201 });
    assert.equal((await api.registerSystemWorkspace({ name: workspace.name, kind: 'local', capabilities: [] })).workspace.id, id);
    let requests = 0;
    globalThis.fetch = async (path, init) => {
      requests++;
      assert.equal(path, `/api/workspaces/${id}`);
      assert.equal(init.method, 'DELETE');
      return new Response(null, { status: 204 });
    };
    await api.deleteSystemWorkspace(id);
    assert.equal(requests, 1);
  }
});

test('malformed responses fail closed without exposing service bodies or tokens', async () => {
  for (const value of [
    {}, { workspaces: null }, { workspaces: [null] }, { workspaces: [{ ...workspace, online: 'true' }] },
    { workspaces: [{ ...workspace, id: '../escape' }] }, { workspaces: [{ ...workspace, capabilities: ['shell.exec'] }] },
    { workspaces: [{ ...workspace, created_at: 'not-a-date' }] },
    { workspaces: [{ ...workspace, last_seen_at: 'not-a-date' }] },
  ]) {
    globalThis.fetch = async () => Response.json(value);
    await assert.rejects(api.listSystemWorkspaces(), error => error.status === 502);
  }
  for (const connection_token of ['', null, 'with whitespace', 'x'.repeat(4097)]) {
    globalThis.fetch = async () => Response.json({ workspace, connection_token });
    await assert.rejects(api.registerSystemWorkspace({ name: '环境', kind: 'local', capabilities: [] }), error => error.status === 502);
  }
});

test('authentication and network errors remain actionable and mutations are not retried', async () => {
  let requests = 0;
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ error: { id: 'private-error-with-sensitive-details' } }, { status: 401 });
  };
  await assert.rejects(api.listSystemWorkspaces(), error => {
    assert.equal(api.workspaceConnectionError(error), '登录已失效，请重新登录后管理连接。');
    return true;
  });
  assert.equal(requests, 1);
  globalThis.fetch = async () => { requests++; throw new TypeError('response lost'); };
  await assert.rejects(api.registerSystemWorkspace({ name: '环境', kind: 'local', capabilities: [] }), /response lost/);
  assert.equal(requests, 2);
  assert.doesNotMatch(api.workspaceConnectionError(new Error('secret')), /secret/);
  assert.match(api.workspaceConnectionError(new AuthError(503)), /暂不可用/);
  assert.match(api.workspaceConnectionError(new AuthError(429)), /过于频繁/);
  assert.match(api.workspaceConnectionError(new AuthError(400, { error: { id: 'invalid_workspace_request' } })), /最多 80 字/);
  assert.match(api.workspaceConnectionError(new AuthError(409, { error: { id: 'workspace_limit_reached' } })), /数量已达上限/);
  assert.match(api.workspaceConnectionError(new AuthError(403, { error: { id: 'workspace_capability_denied' } })), /能力未获许可/);
});

test('read cancellation is passed through the auth transport', async () => {
  const controller = new AbortController();
  globalThis.fetch = (_path, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const reading = api.listSystemWorkspaces(controller.signal);
  controller.abort();
  await assert.rejects(reading, error => error.name === 'AbortError');
});

test('exact lazy route precedes the unchanged knowledge workspace prefix route', async () => {
  const entry = await readFile(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.ok(entry.indexOf("location.pathname === '/workspace/connections'") < entry.indexOf("location.pathname.startsWith('/workspace')"));
  assert.match(entry, /pathname === '\/workspace\/connections' \? import\('\.\/workspace-connections'\)/);
  assert.match(entry, /pathname\.startsWith\('\/workspace'\) \? import\('\.\/workspace'\)/);
});

test('settings keep the connection-management link behind a switch until users can get the CLI', async () => {
  const settings = await readFile(new URL('../src/components/workspace-settings.tsx', import.meta.url), 'utf8');
  // The link is written and ready, and shown only once the switch is turned on.
  assert.match(settings, /\{SYSTEM_WORKSPACES_LISTED \? <SettingRow title="系统工作空间连接"[^]*?href="\/workspace\/connections"/);
  assert.match(settings, /const SYSTEM_WORKSPACES_LISTED = false;/);
  // Search does not lead to a page Settings does not show.
  assert.doesNotMatch(settings, /keywords: '[^']*系统工作空间连接[^']*'/);
});

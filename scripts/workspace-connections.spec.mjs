import { test, expect } from '@playwright/test';

const token = 'one-time-connection-token-test-only';
const example = {
  id: '0123456789abcdef0123456789abcdef', name: '测试系统环境', kind: 'local',
  capabilities: [], online: false, last_seen_at: null, created_at: '2026-10-03T10:00:00Z',
};

async function mockService(page, initial = []) {
  const state = {
    rows: [...initial], calls: [], listStatus: 200, registerStatus: 201, deleteStatus: 204, registrationId: example.id,
    optionsStatus: 200, options: { local_registration_supported: true, cloud_registration_supported: false },
    librariesStatus: 200, libraries: [], entriesStatus: 200, entries: {}, cloudStatus: 201, cloudError: 'agent_not_found',
    cloudResponseExtras: {},
  };
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    state.calls.push({ method: request.method(), path, body: request.postDataJSON() });
    if (path === '/api/workspaces/registration-options' && request.method() === 'GET') {
      await route.fulfill({ status: state.optionsStatus, json: state.optionsStatus === 200 ? state.options : { error: { id: 'registration_unavailable' } } });
    } else if (path === '/api/libraries' && request.method() === 'GET') {
      await route.fulfill({ status: state.librariesStatus, json: state.librariesStatus === 200 ? { libraries: state.libraries } : { error: { id: 'library_unavailable' } } });
    } else if (/^\/api\/libraries\/[0-9a-f]{32}\/entries$/.test(path) && request.method() === 'GET') {
      const id = path.split('/')[3];
      await route.fulfill({ status: state.entriesStatus, json: state.entriesStatus === 200 ? { entries: state.entries[id] ?? [] } : { error: { id: 'library_unavailable' } } });
    } else if (path === '/api/workspaces' && request.method() === 'GET') {
      await route.fulfill({ status: state.listStatus, json: state.listStatus === 200 ? { workspaces: state.rows } : { error: { id: 'workspace_unavailable' } } });
    } else if (path === '/api/workspaces' && request.method() === 'POST') {
      const body = request.postDataJSON();
      if (body.kind === 'cloud') {
        if (state.cloudStatus !== 201) {
          await route.fulfill({ status: state.cloudStatus, json: { error: { id: state.cloudError } } });
          return;
        }
        const workspace = { ...example, id: state.registrationId, name: body.name, kind: 'cloud', capabilities: body.capabilities };
        state.rows.push(workspace);
        await route.fulfill({ status: 201, json: { workspace, ...state.cloudResponseExtras } });
        return;
      }
      if (state.registerStatus !== 201) {
        await route.fulfill({ status: state.registerStatus, json: { error: { id: 'invalid_workspace' } } });
        return;
      }
      const workspace = { ...example, id: state.registrationId, ...request.postDataJSON() };
      state.rows.push(workspace);
      await route.fulfill({ status: 201, json: { workspace, connection_token: token } });
    } else if (request.method() === 'DELETE' && state.rows.some(row => path === `/api/workspaces/${row.id}`)) {
      if (state.deleteStatus === 204) {
        state.rows = state.rows.filter(row => path !== `/api/workspaces/${row.id}`);
        await route.fulfill({ status: 204 });
      } else await route.fulfill({ status: state.deleteStatus, json: { error: { id: 'workspace_not_found' } } });
    } else await route.fulfill({ status: 404, json: { error: { id: 'unexpected_test_request' } } });
  });
  await page.addInitScript(() => {
    window.__clipboardWrites = 0;
    if (navigator.clipboard) navigator.clipboard.writeText = async () => { window.__clipboardWrites++; throw new Error('No automatic copying'); };
  });
  return state;
}

async function open(page) {
  await page.goto('/workspace/connections');
  await expect(page.getByRole('heading', { name: '系统工作空间连接', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
}

const cloudLibrary = {
  id: 'b'.repeat(32), name: '自有 Agent 资料库', role: 'owner',
  created_at: example.created_at, updated_at: example.created_at,
};
const cloudLibrary2 = { ...cloudLibrary, id: 'c'.repeat(32), name: '另一自有资料库' };
const cloudAgent = {
  id: 'a'.repeat(32), library_id: cloudLibrary.id, parent_id: '', kind: 'agent', title: '我的云端 Agent',
  body: 'private-agent-body-never-render-or-roundtrip', created_at: example.created_at, updated_at: example.created_at,
};
const cloudAgent2 = { ...cloudAgent, id: 'd'.repeat(32), library_id: cloudLibrary2.id, title: '第二个云端 Agent' };
const cloudSubmit = page => page.getByRole('button', { name: '登记云端环境（无连接令牌）', exact: true });
const cloudPi = page => page.getByRole('checkbox', { name: /允许同账号环境调用此云端 Pi/ });

function enableCloud(state) {
  state.options = { local_registration_supported: true, cloud_registration_supported: true };
  state.libraries = [cloudLibrary, cloudLibrary2,
    { ...cloudLibrary, id: 'e'.repeat(32), name: '订阅资料库不可用', role: 'subscribed' },
    { ...cloudLibrary, id: 'f'.repeat(32), name: '未确认所有权不可用', role: undefined }];
  state.entries = {
    [cloudLibrary.id]: [cloudAgent,
      { ...cloudAgent, id: '1'.repeat(32), kind: 'note', title: '笔记不能用作 Agent' },
      { ...cloudAgent, id: '2'.repeat(32), kind: 'work_env', title: '项目不能用作 Agent' },
      { ...cloudAgent, id: '3'.repeat(32), library_id: cloudLibrary2.id, title: '其他资料库 Agent 不可用' }],
    [cloudLibrary2.id]: [cloudAgent2],
  };
}

async function chooseCloudAgent(page, library = cloudLibrary, agent = cloudAgent) {
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeEnabled();
  await page.getByLabel('你拥有的资料库', { exact: true }).selectOption(library.id);
  await expect(page.getByLabel('云端 Agent 定义', { exact: true })).toBeEnabled();
  await page.getByLabel('云端 Agent 定义', { exact: true }).selectOption(agent.id);
  await page.getByLabel('云端环境名称', { exact: true }).fill('我的托管云环境');
}

for (const [label, options, status] of [
  ['false', { cloud_registration_supported: false }, 200],
  ['missing', {}, 200],
  ['nonboolean string', { cloud_registration_supported: 'true' }, 200],
  ['nonboolean number', { cloud_registration_supported: 1 }, 200],
  ['404', {}, 404],
  ['failure', {}, 503],
]) {
  test(`cloud creation fails closed for ${label} while local registration remains usable`, async ({ page }) => {
    const state = await mockService(page);
    state.options = options;
    state.optionsStatus = status;
    await open(page);
    await expect(page.getByRole('button', { name: '重新检查云端登记支持' })).toBeVisible();
    await expect(cloudSubmit(page)).toHaveCount(0);
    await expect(page.getByLabel('你拥有的资料库', { exact: true })).toHaveCount(0);
    expect(state.calls.some(call => call.path === '/api/libraries')).toBe(false);
    await page.getByLabel('环境名称', { exact: true }).fill('本地仍可登记');
    await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
    await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
    expect(state.calls.filter(call => call.method === 'POST').map(call => call.body.kind)).toEqual(['local']);
  });
}

test('cloud owner-only catalog lazily selects exact-library Agents and never retains entry bodies', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  await open(page);
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeEnabled();
  expect(state.calls.some(call => call.path.endsWith('/entries'))).toBe(false);
  await expect(page.locator('#cloud-library option')).toHaveText(['选择资料库', cloudLibrary.name, cloudLibrary2.name]);
  await expect(page.getByLabel('云端 Agent 定义', { exact: true })).toBeDisabled();
  await chooseCloudAgent(page);
  await expect(page.locator('#cloud-agent option')).toHaveText(['选择 Agent 定义', cloudAgent.title]);
  await expect(cloudPi(page)).not.toBeChecked();
  await expect(page.getByText(/云端登记后暂不能修改能力授权/)).toBeVisible();
  expect(await page.locator('body').textContent()).not.toContain(cloudAgent.body);
  expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(cloudAgent.body);
  expect(state.calls.filter(call => call.path.endsWith('/entries')).map(call => call.path)).toEqual([`/api/libraries/${cloudLibrary.id}/entries`]);
  expect(state.calls.some(call => call.method !== 'GET')).toBe(false);
});

test('cloud catalog and Agent loading, empty and retryable errors never enable mutation', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  state.libraries = state.libraries.filter(library => library.role !== 'owner');
  await open(page);
  await expect(page.getByText(/没有可选的自有资料库/)).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  state.libraries = [cloudLibrary];
  state.librariesStatus = 503;
  await page.reload();
  await expect(page.getByRole('button', { name: '重新读取拥有的资料库' })).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  state.librariesStatus = 200;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/libraries', async route => { await waiting; await route.fallback(); });
  await page.getByRole('button', { name: '重新读取拥有的资料库' }).click();
  await expect(page.getByText('正在读取你拥有的资料库…', { exact: true })).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  release();
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeEnabled();
  state.entriesStatus = 503;
  await page.getByLabel('你拥有的资料库', { exact: true }).selectOption(cloudLibrary.id);
  await expect(page.getByRole('button', { name: '重新读取 Agent 定义' })).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  state.entriesStatus = 200;
  state.entries[cloudLibrary.id] = [];
  await page.getByRole('button', { name: '重新读取 Agent 定义' }).click();
  await expect(page.getByText(/没有可绑定的 Agent 定义/)).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  expect(state.calls.some(call => call.method === 'POST')).toBe(false);
});

test('cloud rapid library selection aborts and ignores stale Agent responses', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/libraries/${cloudLibrary.id}/entries`, async route => { await waiting; await route.fallback(); });
  await open(page);
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeEnabled();
  await page.getByLabel('你拥有的资料库', { exact: true }).selectOption(cloudLibrary.id);
  await expect(page.getByText('正在读取所选资料库的 Agent…', { exact: true })).toBeVisible();
  await expect(cloudSubmit(page)).toBeDisabled();
  await page.getByLabel('你拥有的资料库', { exact: true }).selectOption(cloudLibrary2.id);
  await expect(page.locator('#cloud-agent option')).toHaveText(['选择 Agent 定义', cloudAgent2.title]);
  release();
  await page.getByLabel('云端 Agent 定义', { exact: true }).selectOption(cloudAgent2.id);
  await page.getByLabel('云端环境名称', { exact: true }).fill('切换后绑定');
  await cloudSubmit(page).click();
  await expect(page.getByRole('heading', { name: '切换后绑定', exact: true })).toBeVisible();
  expect(state.calls.find(call => call.method === 'POST').body.agent_entry_id).toBe(cloudAgent2.id);
  await expect(page.locator('#cloud-agent option')).toHaveText(['选择 Agent 定义', cloudAgent2.title]);
});

for (const allowPi of [false, true]) {
  test(`cloud success uses exact binding and ${allowPi ? 'explicit Pi consent' : 'default empty grants'} without token/native actions`, async ({ page }) => {
    const state = await mockService(page);
    enableCloud(state);
    await mockNative(page, { initialized: true, extended: true });
    await open(page);
    await chooseCloudAgent(page);
    await expect(cloudPi(page)).not.toBeChecked();
    if (allowPi) await cloudPi(page).check();
    await cloudSubmit(page).click();
    await expect(page.getByRole('heading', { name: '我的托管云环境', exact: true })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: '已登记云端环境' })).toContainText('没有自动调用 Agent');
    expect(state.calls.filter(call => call.method === 'POST')).toEqual([{
      method: 'POST', path: '/api/workspaces', body: {
        name: '我的托管云环境', kind: 'cloud', capabilities: allowPi ? ['pi.prompt'] : [], agent_entry_id: cloudAgent.id,
      },
    }]);
    await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
    expect(await page.evaluate(() => window.__nativeCalls.filter(call => !['workspace_cli_availability', 'workspace_cli_status', 'workspace_cli_connector_status', 'workspace_cli_approvals'].includes(call.command)))).toEqual([]);
    expect(state.calls.every(call => call.path === '/api/workspaces' || call.path === '/api/workspaces/registration-options'
      || call.path === '/api/libraries' || call.path === `/api/libraries/${cloudLibrary.id}/entries`)).toBe(true);
    expect(page.url()).not.toContain(cloudAgent.id);
    const storage = await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '));
    expect(storage).not.toContain(cloudAgent.id);
    expect(storage).not.toContain(cloudAgent.body);
    expect(storage).not.toContain(token);
    expect(await page.evaluate(() => window.__clipboardWrites)).toBe(0);
    await expect(cloudPi(page)).not.toBeChecked();
    await page.getByRole('button', { name: '撤销「我的托管云环境」的连接' }).click();
    await page.getByRole('button', { name: '确认撤销连接' }).click();
    await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
    expect(state.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  });
}

for (const agentError of ['agent_not_found', 'cloud_agent_not_owned']) {
  test(`cloud authoritative ${agentError} rejection remains visible and does not retry`, async ({ page }) => {
    const state = await mockService(page);
    enableCloud(state);
    state.cloudStatus = 404;
    state.cloudError = agentError;
    await open(page);
    await chooseCloudAgent(page);
    await cloudSubmit(page).click();
    await expect(page.getByRole('alert')).toContainText('Agent 可能已删除或所有权已变化');
    await expect(cloudSubmit(page)).toBeEnabled();
    expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
    await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: '我的托管云环境', exact: true })).toHaveCount(0);
  });
}

test('cloud unexpected token response fails closed without revealing or retaining secret extras', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  state.cloudResponseExtras = { connection_token: 'unexpected-cloud-token-never-show', private_key: 'private-key-not-public' };
  await open(page);
  await chooseCloudAgent(page);
  await cloudSubmit(page).click();
  await expect(page.getByRole('alert')).toContainText('云端登记未确认成功');
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  expect(await page.locator('body').textContent()).not.toContain(state.cloudResponseExtras.connection_token);
  expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain(state.cloudResponseExtras.connection_token);
  expect(page.url()).not.toContain(state.cloudResponseExtras.connection_token);
});

test('cloud mutation shares busy lock with local registration and revocation', async ({ page }) => {
  const state = await mockService(page, [example]);
  enableCloud(state);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspaces', async route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().kind === 'cloud') await waiting;
    await route.fallback();
  });
  await open(page);
  await chooseCloudAgent(page);
  await page.getByLabel('环境名称', { exact: true }).fill('不可同时登记');
  await cloudSubmit(page).click();
  await expect(page.getByRole('button', { name: '正在登记云端环境…' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '登记并显示一次性令牌' })).toBeDisabled();
  await expect(page.getByRole('button', { name: `撤销「${example.name}」的连接` })).toBeDisabled();
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeDisabled();
  release();
  await expect(page.getByRole('heading', { name: '我的托管云环境', exact: true })).toBeVisible();
  expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
});

test('cloud authentication expiry unmounts catalog and selection before identity recheck', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  await open(page);
  await chooseCloudAgent(page);
  await cloudPi(page).check();
  state.listStatus = 401;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toHaveCount(0);
  state.listStatus = 200;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('云端 Agent 定义', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('云端环境名称', { exact: true })).toHaveValue('');
  await expect(cloudPi(page)).not.toBeChecked();
  await expect(cloudSubmit(page)).toBeDisabled();
  expect(state.calls.some(call => call.method === 'POST')).toBe(false);
});

test('cloud pagehide aborts late registration and does not run success callback on restore', async ({ page }) => {
  const state = await mockService(page);
  enableCloud(state);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspaces', async route => {
    if (route.request().method() === 'POST') await waiting;
    await route.fallback();
  });
  await open(page);
  await chooseCloudAgent(page);
  await cloudSubmit(page).click();
  await expect(page.getByRole('button', { name: '正在登记云端环境…' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  release();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
  await expect(page.getByRole('status').filter({ hasText: '已登记云端环境' })).toHaveCount(0);
  await expect(page.getByLabel('你拥有的资料库', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('云端 Agent 定义', { exact: true })).toHaveValue('');
  await expect(cloudPi(page)).not.toBeChecked();
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
});

for (const [width, height, theme] of [[1440, 900, 'light'], [390, 844, 'dark']]) {
  test(`cloud picker accessible responsive ${width}x${height} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(mode => localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode })), theme);
    const state = await mockService(page);
    enableCloud(state);
    await open(page);
    await chooseCloudAgent(page);
    await page.getByLabel('你拥有的资料库', { exact: true }).focus();
    await expect(page.getByLabel('你拥有的资料库', { exact: true })).toBeFocused();
    expect(await page.getByLabel('你拥有的资料库', { exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await cloudPi(page).focus();
    await page.keyboard.press('Space');
    await expect(cloudPi(page)).toBeChecked();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.connections-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.locator('.connections-cloud-register').screenshot({ path: testInfo.outputPath('cloud-picker.png') });
  });
}

test('empty registration uses default-deny capabilities and only explicit creation reveals a token', async ({ page }) => {
  const state = await mockService(page);
  await open(page);
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
  await expect(page.getByRole('heading', { name: '本机 CLI · 桌面客户端' })).toHaveCount(0);
  await expect(page.getByRole('link', { name: '返回资料工作台' })).toHaveAttribute('href', '/workspace');
  await expect(page.getByRole('checkbox')).toHaveCount(4);
  for (const checkbox of await page.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  await expect(page.getByRole('heading', { name: `「${example.name}」的连接令牌` })).toBeFocused();
  expect(state.calls.filter(call => call.method === 'POST')).toEqual([{ method: 'POST', path: '/api/workspaces', body: { name: example.name, kind: 'local', capabilities: [] } }]);
  expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain(token);
  expect(page.url()).not.toContain(token);
  expect(await page.evaluate(() => window.__clipboardWrites)).toBe(0);
  expect((await page.locator('pre').allTextContents()).join(' ')).not.toContain(token);
  await page.getByRole('button', { name: '我已保存到对应主机，关闭令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await expect(page.getByLabel('环境名称', { exact: true })).toBeFocused();
  await page.reload();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: example.name, exact: true })).toBeVisible();
});

test('explicit capabilities, server online status, and confirmed revocation use real requests', async ({ page }) => {
  const state = await mockService(page);
  await open(page);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await expect(page.getByRole('radio', { name: '云端环境' })).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Pi 提示任务' }).check();
  await page.getByRole('checkbox', { name: 'MCP 工具调用' }).check();
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  expect(state.calls.find(call => call.method === 'POST').body).toEqual({ name: example.name, kind: 'local', capabilities: ['pi.prompt', 'mcp.call'] });
  state.rows[0] = { ...state.rows[0], online: true, last_seen_at: '2026-10-03T10:05:00Z' };
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.locator('.connections-status')).toHaveText('在线');
  const revoke = page.getByRole('button', { name: `撤销「${example.name}」的连接` });
  await revoke.click();
  await expect(page.getByRole('button', { name: '确认撤销连接' })).toBeFocused();
  expect(state.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await expect(revoke).toBeFocused();
  await revoke.click();
  await page.getByRole('button', { name: '确认撤销连接' }).click();
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  expect(state.calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  expect(state.calls.every(call => call.path === '/api/workspaces' || call.path === '/api/workspaces/registration-options' || call.path === `/api/workspaces/${example.id}`)).toBe(true);
});

test('loading, list failures, registration failures and missing delete remain visible and retryable', async ({ page }) => {
  const state = await mockService(page);
  state.listStatus = 503;
  await page.route('**/api/workspaces', async route => { await new Promise(resolve => setTimeout(resolve, 150)); await route.fallback(); });
  await page.goto('/workspace/connections');
  await expect(page.getByRole('status', { name: '' }).filter({ hasText: '正在读取系统工作空间' })).toBeVisible();
  await expect(page.getByRole('alert')).toContainText('暂不可用');
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toHaveCount(0);
  state.listStatus = 200;
  await page.getByRole('button', { name: '重试读取' }).click();
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
  state.registerStatus = 400;
  await page.getByLabel('环境名称', { exact: true }).fill('保留草稿');
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByRole('alert')).toContainText('先刷新核对');
  await expect(page.getByLabel('环境名称', { exact: true })).toHaveValue('保留草稿');
  expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  state.rows = [example];
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await page.getByRole('button', { name: `撤销「${example.name}」的连接` }).click();
  state.deleteStatus = 404;
  await page.getByRole('button', { name: '确认撤销连接' }).click();
  await expect(page.getByRole('alert')).toContainText('未确认撤销成功');
  await expect(page.getByRole('heading', { name: example.name, exact: true })).toBeVisible();
});

test('history lifecycle and authentication failure clear the one-time secret', async ({ page }) => {
  const state = await mockService(page);
  await open(page);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await page.getByLabel('环境名称', { exact: true }).fill('第二个环境');
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  state.listStatus = 401;
  await page.getByRole('button', { name: '刷新列表', exact: true }).click();
  await expect(page.getByRole('link', { name: '重新登录', exact: true })).toBeVisible();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '第二个环境', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '登记并显示一次性令牌' })).toBeDisabled();
});

test('managed cloud entries can be listed and revoked without a generic cloud token registration', async ({ page }) => {
  const state = await mockService(page, [{ ...example, kind: 'cloud', name: '托管云环境' }]);
  await open(page);
  await expect(page.getByRole('heading', { name: '托管云环境', exact: true })).toBeVisible();
  await expect(page.getByText('云端系统环境', { exact: true })).toBeVisible();
  await expect(page.getByRole('radio', { name: '云端环境' })).toHaveCount(0);
  await expect(page.getByText(/托管云环境须绑定你拥有的 Agent 定义/)).toBeVisible();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  expect(state.calls.filter(call => call.method === 'POST')).toHaveLength(0);
  await page.getByRole('button', { name: '撤销「托管云环境」的连接' }).click();
  await page.getByRole('button', { name: '确认撤销连接' }).click();
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
});

test('a registration response arriving after page hide cannot reveal a token on restore', async ({ page }) => {
  await mockService(page);
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  await page.route('**/api/workspaces', async route => {
    if (route.request().method() === 'POST') await waiting;
    await route.fallback();
  });
  await open(page);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByRole('button', { name: '正在登记…' })).toBeDisabled();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  release();
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: '刷新列表', exact: true })).toBeEnabled();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('操作结果尚未确认');
});

async function mockNative(page, { available = true, initialized = false, initCancelled = false, extended = false, omitMutationFlags = false, support = {} } = {}) {
  await page.addInitScript(settings => {
    window.isTauri = true;
    window.__nativeCalls = [];
    window.__nativeSettings = settings;
    const config = {
      version: 1, id: 'local-test-environment', name: '本机测试环境', root: '/test/selected-by-native',
      allowed_capabilities: [], linked: false,
      endpoints: [{ name: 'original-model', model: 'existing-model', base_origin: 'https://original.example', requires_key: true, key_available: true }],
      plugins: ['existing-plugin.ts'], mcp_servers: ['existing-mcp'],
      runtime_auth: { claude: { mode: 'host-file', model: 'test-claude', configured: true } },
    };
    settings.config = config;
    settings.errors = {};
    settings.connector = { state: 'stopped', error: null };
    settings.approvals = [];
    const publicConfig = () => structuredClone(config);
    window.__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        if (!command.startsWith('workspace_cli_')) return null;
        window.__nativeCalls.push({ command, args });
        if (settings.errors[command]) throw settings.errors[command];
        if (command === 'workspace_cli_availability') return {
          available: settings.available, init_supported: settings.available, connector_supported: settings.extended,
          ...(settings.omitMutationFlags ? {} : {
            configuration_supported: settings.extended, link_supported: settings.extended, capabilities_supported: settings.extended,
            ...settings.support,
          }),
          reason: settings.available ? settings.reason ?? null : 'workspace_cli_unavailable', limitation: 'workspace_cli_local_consent_required',
          executable_source: settings.available ? 'sidecar' : 'unavailable', model_key_persistence: 'session_only',
        };
        if (command === 'workspace_cli_status') {
          if (!settings.initialized) throw 'workspace_cli_not_initialized';
          return publicConfig();
        }
        if (command === 'workspace_cli_init') {
          if (settings.initCancelled) throw 'workspace_cli_cancelled';
          settings.initialized = true;
          config.name = args.name;
          return publicConfig();
        }
        if (command === 'workspace_cli_connector_status') return structuredClone(settings.connector);
        if (command === 'workspace_cli_link') {
          if (settings.holdLink) await new Promise(resolve => { window.__releaseNativeLink = resolve; });
          config.id = args.id;
          config.linked = true;
          return publicConfig();
        }
        if (command === 'workspace_cli_unlink') { config.linked = false; return publicConfig(); }
        if (command === 'workspace_cli_allow') { config.allowed_capabilities = [...args.capabilities]; return publicConfig(); }
        if (command === 'workspace_cli_connector_start') {
          settings.connector = { state: 'starting', error: null };
          return structuredClone(settings.connector);
        }
        if (command === 'workspace_cli_connector_stop') {
          settings.connector = { state: 'stopped', error: null };
          return structuredClone(settings.connector);
        }
        if (command === 'workspace_cli_configure') {
          const current = new Map(config.endpoints.map(endpoint => [endpoint.name, endpoint]));
          for (const endpoint of args.draft.endpoints) current.set(endpoint.name, {
            name: endpoint.name, model: endpoint.model, base_origin: new URL(endpoint.base_url).origin,
            requires_key: false, key_available: false,
          });
          config.endpoints = [...current.values()];
          if (args.draft.plugins?.length) config.plugins = [...new Set([...config.plugins, ...args.draft.plugins.map(plugin => plugin.split(/[\\/]/).at(-1))])];
          return publicConfig();
        }
        if (command === 'workspace_cli_import') {
          config.endpoints = [{ name: 'imported-model', model: 'imported-example', base_origin: 'https://imported.example', requires_key: true, key_available: true }];
          config.plugins = ['imported-plugin.ts'];
          config.mcp_servers = ['imported-tools'];
          return publicConfig();
        }
        if (command === 'workspace_cli_approvals') return structuredClone(settings.approvals);
        if (command === 'workspace_cli_review_approval') {
          settings.approvals = settings.approvals.filter(approval => approval.id !== args.id);
          return { responded: true };
        }
        throw 'unexpected_native_command';
      },
      transformCallback: () => 1,
    };
  }, { available, initialized, initCancelled, extended, omitMutationFlags, support });
}

test('desktop native availability/status is read-only and init passes only a user-provided name', async ({ page }, testInfo) => {
  await mockService(page);
  await mockNative(page);
  await open(page);
  await expect(page.getByRole('heading', { name: '本机 CLI · 桌面客户端' })).toBeVisible();
  await expect(page.getByRole('button', { name: '重新检查本机 CLI' })).toBeEnabled();
  await expect(page.getByText('本机 CLI 可用。', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__nativeCalls.map(call => call.command))).toEqual(['workspace_cli_availability', 'workspace_cli_status']);
  await page.getByLabel('本机环境名称', { exact: true }).fill('独立本机环境');
  await page.getByRole('button', { name: '选择目录并请求本机初始化' }).click();
  await expect(page.getByText('独立本机环境', { exact: true })).toBeVisible();
  await expect(page.getByText('/test/selected-by-native', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__nativeCalls.filter(call => call.command === 'workspace_cli_init'))).toEqual([{ command: 'workspace_cli_init', args: { name: '独立本机环境' } }]);
  expect(await page.evaluate(() => window.__nativeCalls.every(call => ['workspace_cli_availability', 'workspace_cli_status', 'workspace_cli_init'].includes(call.command)))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('native-connections.png') });
});

test('desktop unavailable and cancelled native initialization remain honest', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { available: false });
  await open(page);
  await expect(page.getByText(/本机 CLI 尚不可用/)).toBeVisible();
  await expect(page.getByLabel('本机环境名称', { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => window.__nativeCalls.map(call => call.command))).toEqual(['workspace_cli_availability']);
  await page.evaluate(() => { window.__nativeSettings.available = true; window.__nativeSettings.initCancelled = true; });
  await page.getByRole('button', { name: '重新检查本机 CLI' }).click();
  await page.getByLabel('本机环境名称', { exact: true }).fill('待初始化');
  await page.getByRole('button', { name: '选择目录并请求本机初始化' }).click();
  await expect(page.getByRole('alert')).toContainText('已取消本机操作');
  await expect(page.getByLabel('本机环境名称', { exact: true })).toHaveValue('待初始化');
});

async function nativeMutations(page, command) {
  return page.evaluate(filter => window.__nativeCalls.filter(call =>
    filter ? call.command === filter : !['workspace_cli_availability', 'workspace_cli_status', 'workspace_cli_connector_status', 'workspace_cli_approvals'].includes(call.command)), command);
}

async function registerAndLink(page) {
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  await page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
}

for (const firstByte of [0xf8, 0xfc]) {
  const bytes = Buffer.alloc(32);
  bytes[0] = firstByte;
  const id = bytes.toString('base64url');
  test(`generated server43 ID starting ${id[0]} registers, lists, links explicitly and revokes without secret persistence`, async ({ page }) => {
    expect(id).toHaveLength(43);
    const state = await mockService(page);
    state.registrationId = id;
    await mockNative(page, { initialized: true, extended: true });
    await open(page);
    await registerAndLink(page);
    expect(await nativeMutations(page, 'workspace_cli_link')).toEqual([{ command: 'workspace_cli_link', args: { id, token } }]);
    await page.getByRole('button', { name: '刷新列表', exact: true }).click();
    await expect(page.getByRole('heading', { name: example.name, exact: true })).toBeVisible();
    await expect(page.locator('.connections-list code')).toHaveText(id);
    expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(0);
    expect(page.url()).not.toContain(token);
    expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain(token);
    expect(await page.evaluate(() => window.__clipboardWrites)).toBe(0);
    await page.getByRole('button', { name: `撤销「${example.name}」的连接` }).click();
    await page.getByRole('button', { name: '确认撤销连接' }).click();
    await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
    expect(state.calls.filter(call => call.method === 'DELETE')).toEqual([{ method: 'DELETE', path: `/api/workspaces/${id}`, body: null }]);
  });
}

test('missing or nonboolean native mutation flags fail closed independently of connector support', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true, omitMutationFlags: true });
  await open(page);
  await expect(page.getByText(/当前原生桥尚未支持关联或解除关联/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeDisabled();
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByRole('button', { name: '添加模型端点' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '在原生窗口导入 MCP 与高级配置' })).toBeDisabled();
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await expect(page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' })).toBeDisabled();
  expect(await nativeMutations(page)).toEqual([]);
  await page.evaluate(() => {
    window.__nativeSettings.omitMutationFlags = false;
    window.__nativeSettings.support = { link_supported: true, capabilities_supported: 'true', configuration_supported: false };
  });
  await page.getByRole('button', { name: '重新检查本机 CLI' }).click();
  await expect(page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' })).toBeEnabled();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeDisabled();
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByRole('button', { name: '在原生窗口导入 MCP 与高级配置' })).toBeDisabled();
  expect(await nativeMutations(page)).toEqual([]);
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
});

test('desktop explicit register → native token link, local permissions and connector lifecycle', async ({ page }, testInfo) => {
  const service = await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await expect(page.getByRole('button', { name: '重新检查本机 CLI' })).toBeEnabled();
  expect(await nativeMutations(page)).toEqual([]);
  await expect(page.getByRole('button', { name: '请求启动本机连接器' })).toBeDisabled();
  for (const checkbox of await page.getByRole('checkbox', { name: /^本机 / }).all()) await expect(checkbox).not.toBeChecked();

  await registerAndLink(page);
  expect(await nativeMutations(page, 'workspace_cli_link')).toEqual([{ command: 'workspace_cli_link', args: { id: example.id, token } }]);
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toEqual([]);
  expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain(token);
  expect(page.url()).not.toContain(token);
  expect(await page.evaluate(() => window.__clipboardWrites)).toBe(0);
  expect((await page.locator('pre').allTextContents()).join(' ')).not.toContain(token);
  await expect(page.getByRole('heading', { name: '本机 CLI · 桌面客户端' })).toBeFocused();

  await page.getByRole('checkbox', { name: '本机 Pi 提示任务' }).check();
  await page.getByRole('checkbox', { name: '本机 MCP 工具调用' }).check();
  await page.getByRole('button', { name: '请求保存本机许可' }).click();
  expect(await nativeMutations(page, 'workspace_cli_allow')).toEqual([{ command: 'workspace_cli_allow', args: { capabilities: ['pi.prompt', 'mcp.call'] } }]);
  await page.getByRole('button', { name: '请求撤销全部本机许可' }).click();
  expect((await nativeMutations(page, 'workspace_cli_allow')).at(-1).args).toEqual({ capabilities: [] });

  await page.getByRole('button', { name: '请求启动本机连接器' }).click();
  await expect(page.getByText('正在启动，尚未确认就绪', { exact: true })).toBeVisible();
  await expect(page.getByText('运行中，启动心跳已确认', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '请求启动本机连接器' })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeDisabled();
  await expect(page.locator('.connections-status')).toHaveText('离线');
  await page.evaluate(() => { window.__nativeSettings.connector = { state: 'running', error: null }; });
  await expect(page.getByText('运行中，启动心跳已确认', { exact: true })).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(1);
  await page.locator('.connections-native-state').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-running.png') });
  await page.getByRole('button', { name: '请求停止本机连接器' }).click();
  await expect(page.getByText('已停止', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeEnabled();
  await page.getByRole('button', { name: '请求解除本机关联' }).click();
  await expect(page.getByRole('button', { name: '请求启动本机连接器' })).toBeDisabled();
  expect(service.calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  await page.getByRole('button', { name: `撤销「${example.name}」的连接` }).click();
  await page.getByRole('button', { name: '确认撤销连接' }).click();
  await expect(page.getByRole('heading', { name: '还没有系统环境连接' })).toBeVisible();
  expect(service.calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await page.screenshot({ path: testInfo.outputPath('native-lifecycle.png') });
});

test('native cancellation retains one-time token without retry; confirmed link clears it', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await page.evaluate(() => { window.__nativeSettings.errors.workspace_cli_link = 'workspace_cli_cancelled'; });
  await page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' }).click();
  await expect(page.getByRole('alert')).toContainText('已取消本机操作');
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveValue(token);
  expect(await nativeMutations(page, 'workspace_cli_link')).toHaveLength(1);
  await page.evaluate(() => { delete window.__nativeSettings.errors.workspace_cli_link; });
  await page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' }).click();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  expect(await nativeMutations(page, 'workspace_cli_link')).toHaveLength(2);
});

test('configuration adds declarative drafts without roundtripping redacted originals; extensions need consent and native-picked import', async ({ page }, testInfo) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByText('https://original.example', { exact: true })).toBeVisible();
  await expect(page.getByLabel('端点 1 API 地址', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('追加本地扩展引用（每行一个，可留空）')).toHaveValue('');
  await expect(page.getByRole('button', { name: '请求保存端点与插件配置' })).toBeDisabled();
  await page.getByRole('button', { name: '添加模型端点' }).click();
  await page.getByLabel('端点 1 名称', { exact: true }).fill('new-model');
  await page.getByLabel('端点 1 模型', { exact: true }).fill('test-model');
  await page.getByLabel('端点 1 API 地址', { exact: true }).fill('https://new.example/v1?api_key=not-a-real-secret');
  await page.getByLabel('追加本地扩展引用（每行一个，可留空）').fill('npm:test-plugin@1');
  await expect(page.getByRole('button', { name: '请求保存端点与插件配置' })).toBeDisabled();
  await page.getByRole('checkbox', { name: /^我已核对扩展来源/ }).check();
  await page.getByRole('button', { name: '请求保存端点与插件配置' }).click();
  await expect(page.getByRole('alert')).toContainText('密钥须通过原生窗口导入');
  expect(await nativeMutations(page, 'workspace_cli_configure')).toEqual([]);
  await page.getByLabel('端点 1 API 地址', { exact: true }).fill('https://new.example/v1');
  await page.getByRole('button', { name: '请求保存端点与插件配置' }).click();
  await expect(page.getByRole('alert')).toContainText('绝对本地扩展路径');
  expect(await nativeMutations(page, 'workspace_cli_configure')).toEqual([]);
  await page.getByLabel('追加本地扩展引用（每行一个，可留空）').fill('/test/extensions/test-plugin.ts');
  await expect(page.getByRole('checkbox', { name: /^我已核对扩展来源/ })).not.toBeChecked();
  await page.getByRole('checkbox', { name: /^我已核对扩展来源/ }).check();
  await page.getByRole('button', { name: '请求保存端点与插件配置' }).click();
  expect(await nativeMutations(page, 'workspace_cli_configure')).toEqual([{
    command: 'workspace_cli_configure', args: { draft: { endpoints: [{ name: 'new-model', base_url: 'https://new.example/v1', model: 'test-model' }], plugins: ['/test/extensions/test-plugin.ts'] } },
  }]);
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByText('https://new.example', { exact: true })).toBeVisible();
  await expect(page.getByText('https://original.example', { exact: true })).toBeVisible();
  await expect(page.getByText(/已有插件引用：existing-plugin.ts · test-plugin.ts/)).toBeVisible();
  await page.getByRole('button', { name: '在原生窗口导入 MCP 与高级配置' }).click();
  expect(await nativeMutations(page, 'workspace_cli_import')).toHaveLength(1);
  expect((await nativeMutations(page, 'workspace_cli_import'))[0].args).toEqual({});
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByText('已配置的 MCP 引用：imported-tools')).toBeVisible();
  await expect(page.getByText('本机凭据引用可用', { exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '本机 MCP 工具调用' })).not.toBeChecked();
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(0);
  expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain('not-a-real-secret');
  await page.getByRole('heading', { name: '已有端点与引用' }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-configuration.png') });
});

test('endpoint-only drafts preserve current references and omitted endpoints; no GUI clearing or full replacement', async ({ page }, testInfo) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await page.getByRole('button', { name: '在原生窗口导入 MCP 与高级配置' }).click();
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByText(/已有插件引用：imported-plugin.ts/)).toBeVisible();
  await expect(page.getByLabel('追加本地扩展引用（每行一个，可留空）')).toHaveValue('');
  await page.getByRole('button', { name: '添加模型端点' }).click();
  await page.getByLabel('端点 1 名称', { exact: true }).fill('endpoint-only');
  await page.getByLabel('端点 1 模型', { exact: true }).fill('test-model');
  await page.getByLabel('端点 1 API 地址', { exact: true }).fill('https://model.example/v1');
  // Simulate an independent CLI/native update after the HTML draft was opened.
  // This is a contract fixture, not evidence of an actual CLI transaction.
  await page.evaluate(() => { window.__nativeSettings.config.plugins = ['intervening-plugin.ts']; });
  await page.getByRole('button', { name: '请求保存端点与插件配置' }).click();
  const preserved = await nativeMutations(page, 'workspace_cli_configure');
  expect(preserved).toHaveLength(1);
  expect(preserved[0].args.draft).toEqual({ endpoints: [{ name: 'endpoint-only', base_url: 'https://model.example/v1', model: 'test-model' }] });
  expect(Object.hasOwn(preserved[0].args.draft, 'plugins')).toBe(false);
  await expect(page.getByText(/当前本机插件引用保持不变；未填写的配置保持不变/)).toBeVisible();
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByText(/已有插件引用：intervening-plugin.ts/)).toBeVisible();
  await expect(page.getByText('https://imported.example', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /清空|替换全部/ })).toHaveCount(0);
  await expect(page.getByRole('radio', { name: /清空|替换全部/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '请求保存端点与插件配置' })).toBeDisabled();
  await expect(page.getByText(/替换或移除配置请使用可信的原生文件导入/)).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('追加本地扩展引用（每行一个，可留空）').scrollIntoViewIfNeeded();
  expect(await page.locator('.connections-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('native-plugin-append.png') });
  expect(await nativeMutations(page, 'workspace_cli_configure')).toHaveLength(1);
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(0);
});

test('Windows configuration/connect-only status prohibits grants but permits explicit revocation', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.evaluate(() => {
    window.__nativeSettings.reason = 'workspace_cli_windows_config_connect_only';
    window.__nativeSettings.config.allowed_capabilities = ['pi.prompt'];
  });
  await page.getByRole('button', { name: '重新检查本机 CLI' }).click();
  await expect(page.getByText(/当前 Windows 客户端仅支持配置、关联和出站连接/)).toBeVisible();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '请求保存本机许可' })).toBeDisabled();
  await page.getByRole('button', { name: '请求撤销全部本机许可' }).click();
  expect(await nativeMutations(page, 'workspace_cli_allow')).toEqual([{ command: 'workspace_cli_allow', args: { capabilities: [] } }]);
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: '本机 Pi 提示任务' })).toBeDisabled();
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await expect(page.getByRole('button', { name: '添加模型端点' })).toBeEnabled();
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(0);
});

test('desktop local approvals expose only metadata and review ID, not web decisions', async ({ page }, testInfo) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await expect(page.getByText(/已配置附件（未验证登录）/)).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_approvals')).toHaveLength(0);
  await page.evaluate(() => { window.__nativeSettings.errors.workspace_cli_approvals = 'workspace_cli_approvals_unavailable'; });
  await page.getByRole('button', { name: '读取本机待审批请求' }).click();
  await expect(page.getByRole('alert')).toContainText('未能读取本机待审批请求');
  await expect(page.getByText('本次读取没有待审批请求；有新任务时请再次读取。')).toHaveCount(0);
  await page.evaluate(() => {
    delete window.__nativeSettings.errors.workspace_cli_approvals;
    window.__nativeSettings.approvals = [{
      id: 'approval-test-only', runtime: 'pi', session_id: 'local-session-test-only',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    }];
  });
  await page.getByRole('button', { name: '读取本机待审批请求' }).click();
  await expect(page.getByRole('heading', { name: 'Pi 待审批' })).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_review_approval')).toHaveLength(0);
  await page.evaluate(() => { window.__nativeSettings.errors.workspace_cli_review_approval = 'workspace_cli_cancelled'; });
  await page.getByRole('button', { name: '在原生窗口审查此请求' }).click();
  await expect(page.getByRole('alert')).toContainText('已取消本机操作');
  await expect(page.getByRole('heading', { name: 'Pi 待审批' })).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_review_approval')).toEqual([{ command: 'workspace_cli_review_approval', args: { id: 'approval-test-only' } }]);
  await page.evaluate(() => { delete window.__nativeSettings.errors.workspace_cli_review_approval; });
  await page.getByRole('button', { name: '在原生窗口审查此请求' }).click();
  await expect(page.getByRole('heading', { name: 'Pi 待审批' })).toHaveCount(0);
  expect((await nativeMutations(page, 'workspace_cli_review_approval')).every(call => Object.keys(call.args).join() === 'id')).toBe(true);
  await page.locator('.connections-native-approvals').scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('native-approvals.png') });
});

test('a late native link response after history hide cannot restore a token or auto-start', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.getByLabel('环境名称', { exact: true }).fill(example.name);
  await page.getByRole('button', { name: '登记并显示一次性令牌' }).click();
  await page.evaluate(() => { window.__nativeSettings.holdLink = true; });
  await page.getByRole('button', { name: '将此连接关联到本机 CLI（原生确认）' }).click();
  await expect(page.getByText('等待本机选择、确认或操作完成…请勿重复提交。')).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
  await expect(page.getByRole('button', { name: '重新检查本机 CLI' })).toBeEnabled();
  await page.evaluate(() => window.__releaseNativeLink());
  await page.getByRole('button', { name: '重新检查本机 CLI' }).click();
  await expect(page.getByRole('button', { name: '请求启动本机连接器' })).toBeEnabled();
  await expect(page.getByLabel('一次性显示的连接令牌（请手动选取）')).toHaveCount(0);
  expect(await nativeMutations(page, 'workspace_cli_link')).toHaveLength(1);
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(0);
  expect(await page.evaluate(() => Object.values(localStorage).join(' ') + Object.values(sessionStorage).join(' '))).not.toContain(token);
});

test('native startup errors and failed status are explicit and never auto-restarted', async ({ page }) => {
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await registerAndLink(page);
  await page.evaluate(() => { window.__nativeSettings.errors.workspace_cli_connector_start = 'workspace_cli_start_failed'; });
  await page.getByRole('button', { name: '请求启动本机连接器' }).click();
  await expect(page.getByRole('alert')).toContainText('未能就绪');
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(1);
  await page.evaluate(() => {
    delete window.__nativeSettings.errors.workspace_cli_connector_start;
    window.__nativeSettings.connector = { state: 'failed', error: 'workspace_cli_connection_timeout' };
  });
  await expect(page.getByText('连接器失败，尚未就绪', { exact: true })).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(1);
  await page.getByRole('button', { name: '重新检查本机 CLI' }).click();
  await expect(page.getByText('连接器失败，尚未就绪', { exact: true })).toBeVisible();
  expect(await nativeMutations(page, 'workspace_cli_connector_start')).toHaveLength(1);
});

test('mobile desktop-native settings compose without overflow', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockService(page);
  await mockNative(page, { initialized: true, extended: true });
  await open(page);
  await page.getByText('模型端点、插件与 MCP 配置', { exact: true }).click();
  await page.getByRole('button', { name: '添加模型端点' }).click();
  await page.getByLabel('端点 1 名称', { exact: true }).fill('mobile-model');
  await page.getByLabel('端点 1 模型', { exact: true }).fill('model-name');
  await page.getByLabel('端点 1 API 地址', { exact: true }).fill('https://model.example/v1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(await page.locator('.connections-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await page.getByLabel('端点 1 API 地址', { exact: true }).focus();
  await expect(page.getByLabel('端点 1 API 地址', { exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('native-mobile-configuration.png') });
});

for (const [width, height, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [360, 800, 'light'], [390, 844, 'dark']]) {
  test(`responsive readable connections ${width}x${height} ${theme}`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(mode => localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode })), theme);
    await mockService(page, [{ ...example, name: '长名称的完整系统环境用于检查窄屏换行与可访问性'.repeat(3), capabilities: ['pi.prompt', 'mcp.call'] }]);
    await open(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    expect(await page.locator('.connections-page').evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await page.getByLabel('环境名称', { exact: true }).focus();
    await expect(page.getByLabel('环境名称', { exact: true })).toBeFocused();
    expect(await page.getByLabel('环境名称', { exact: true }).evaluate(element => getComputedStyle(element).outlineStyle)).not.toBe('none');
    await page.getByRole('checkbox', { name: 'Pi 提示任务' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('checkbox', { name: 'Pi 提示任务' })).toBeChecked();
    await page.locator('.connections-page').evaluate(element => { element.scrollTop = 0; });
    await page.screenshot({ path: testInfo.outputPath('connections.png') });
  });
}

import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const syntheticSessionA = {
  id: 'user-identity-uuid-aaaa',
  email: 'user-a@example.com',
  email_verified: true,
  expires_at: '2099-01-01T00:00:00Z',
};
const syntheticSessionB = {
  id: 'user-identity-uuid-bbbb',
  email: 'user-b@example.com',
  email_verified: true,
  expires_at: '2099-01-01T00:00:00Z',
};

const libA = { id: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', name: '我的知识库', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const libB = { id: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', name: '我的知识库', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const guideA = { id: 'cccccccccccccccccccccccccccccccc', library_id: libA.id, parent_id: '', kind: 'agent', preset: 'guide', title: '新手向导', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const noteA = { id: 'dddddddddddddddddddddddddddddddd', library_id: libA.id, parent_id: '', kind: 'note', title: 'First note for user A', body: 'Private note body', created_at: '2026-01-01T00:00:01.000Z', updated_at: '2026-01-01T00:00:01.000Z' };
const noteC = { ...noteA, id: 'abababababababababababababababab', title: 'Second note for user A', body: 'Another document' };
const createdNote = { id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', library_id: libA.id, parent_id: '', kind: 'note', title: '未命名笔记', created_at: '2026-01-01T00:00:02.000Z', updated_at: '2026-01-01T00:00:02.000Z' };
const sessionA = { id: 'ffffffffffffffffffffffffffffffff', entry_id: guideA.id, messages: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const guideB = { id: '11111111111111111111111111111111', library_id: libB.id, parent_id: '', kind: 'agent', preset: 'guide', title: '新手向导', created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };
const sessionB = { id: '22222222222222222222222222222222', entry_id: guideB.id, messages: [], created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z' };

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function mockUnavailableLoginFlow(page) {
  await page.route('**/api/auth/flow', route => json(route, 503, { error: { id: 'auth_unavailable' } }));
}

function defaultState() {
  return {
    session: syntheticSessionA,
    libraries: [libA],
    entries: [guideA, noteA],
    entryById: { [guideA.id]: { ...guideA }, [noteA.id]: { ...noteA } },
    sessionsByEntry: { [guideA.id]: [sessionA] },
    sessionById: { [sessionA.id]: sessionA },
    model: { configured: false, source: 'product', quota: { limit: 20, used: 0, remaining: 20 } },
    patchError: null,
    sendError: false,
    holdCreate: null,
  };
}

async function mockWorkspace(page, state, { seedWorkspaceUnlock = true } = {}) {
  if (seedWorkspaceUnlock) {
    await page.addInitScript(({ identities, workspaceIds }) => {
      for (const identity of identities) {
        for (const workspaceId of workspaceIds) {
          localStorage.setItem(`tjuclaw.workspace.vault.v1.${identity}.${workspaceId}`, JSON.stringify({
            version: 1,
            salt: 'dGVzdC1zYWx0',
            verifier: 'test-verifier',
            created_at: '2026-01-01T00:00:00.000Z',
          }));
          sessionStorage.setItem(`tjuclaw.workspace.unlock.v1.${identity}.${workspaceId}`, 'unlocked');
        }
      }
    }, {
      identities: [syntheticSessionA.id, syntheticSessionB.id],
      workspaceIds: [libA.id, libB.id],
    });
  }
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/auth/session') return json(route, 200, state.session);
    if (path === '/api/libraries' && method === 'GET') return json(route, 200, { libraries: state.libraries });
    if (path === '/api/libraries' && method === 'POST') {
      const posted = route.request().postDataJSON() || {};
      const library = { ...libA, name: posted.name || '我的知识库' };
      state.libraries = [library];
      return json(route, 201, { library });
    }
    const libEntries = path.match(/^\/api\/libraries\/([0-9a-f]{32})\/entries$/);
    if (libEntries && method === 'GET') {
      const id = libEntries[1];
      return json(route, 200, { entries: state.libraries[0]?.id === id ? state.entries : [] });
    }
    if (libEntries && method === 'POST') {
      if (state.holdCreate) await state.holdCreate;
      if (state.session.id !== syntheticSessionA.id) return json(route, 401, { error: { id: 'session_required' } });
      const posted = route.request().postDataJSON() || {};
      const entry = { ...createdNote, parent_id: posted.parent_id || '', kind: posted.kind || 'note', title: posted.title || createdNote.title };
      state.entries = [...state.entries, entry];
      state.entryById[entry.id] = entry;
      return json(route, 201, { entry });
    }
    const entry = path.match(/^\/api\/entries\/([0-9a-f]{32})$/);
    if (entry && method === 'GET') {
      const found = state.entryById[entry[1]];
      return found ? json(route, 200, { entry: found }) : json(route, 404, { error: { id: 'entry_not_found' } });
    }
    if (entry && method === 'PATCH') {
      if (state.patchError) return json(route, 503, { error: { id: 'library_storage_unavailable' } });
      const found = state.entryById[entry[1]];
      const patch = route.request().postDataJSON();
      const next = { ...found, ...patch, updated_at: '2026-01-01T00:00:03.000Z' };
      state.entryById[entry[1]] = next;
      return json(route, 200, { entry: next });
    }
    const sessions = path.match(/^\/api\/entries\/([0-9a-f]{32})\/sessions$/);
    if (sessions && method === 'GET') return json(route, 200, { sessions: state.sessionsByEntry[sessions[1]] ?? [] });
    if (sessions && method === 'POST') {
      const sess = state.sessionsByEntry[sessions[1]]?.[0] ?? sessionA;
      return json(route, 201, { session: sess });
    }
    const oneSession = path.match(/^\/api\/sessions\/([0-9a-f]{32})$/);
    if (oneSession && method === 'GET') {
      const found = state.sessionById[oneSession[1]] ?? sessionA;
      return json(route, 200, { session: found });
    }
    const message = path.match(/^\/api\/sessions\/([0-9a-f]{32})\/messages$/);
    if (message && method === 'POST') {
      if (state.sendError) return json(route, 503, { error: { id: 'agent_unavailable' } });
      const content = route.request().postDataJSON().content;
      const previous = state.sessionById[message[1]] ?? sessionA;
      const next = { ...previous, messages: [
        ...(previous.messages ?? []),
        { role: 'user', content, created_at: '2026-01-01T00:00:10.000Z' },
        { role: 'assistant', content: '**已收到**你的问题。', created_at: '2026-01-01T00:00:11.000Z' },
      ] };
      state.sessionById[message[1]] = next;
      return json(route, 200, { session: next });
    }
    if (path === '/api/account/model') {
      return json(route, 200, { model: state.model });
    }
    if (path === '/api/market' && method === 'GET') return json(route, 200, { publications: [] });
    if (path.endsWith('/publications') && method === 'GET') return json(route, 200, { publications: [] });
    if (path.endsWith('/search') && method === 'GET') return json(route, 200, { hits: [] });



    return json(route, 404, { error: { id: 'not_found' } });
  });
}

test.describe('Workspace mocked contract suite', () => {
  test('requires a workspace passphrase before opening workspace data', async ({ page }) => {
    await mockWorkspace(page, defaultState(), { seedWorkspaceUnlock: false });
    await page.goto('/workspace');
    await expect(page.getByRole('heading', { name: '创建工作区口令' })).toBeVisible();
    await expect(page.getByText('口令丢失后不可找回，也不能修改。不同工作区不会共用口令。')).toBeVisible();
    await expect(page.getByText('Private note body')).toHaveCount(0);
    await page.getByRole('textbox', { name: '创建工作区口令' }).fill('workspace-secret-2026');
    await page.getByLabel('再次输入口令').fill('workspace-secret-2026');
    await page.getByRole('checkbox').check();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '创建并下载备份' }).click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toContain('passphrase.txt');
    await expect(page.getByRole('heading', { name: '口令已创建' })).toBeVisible();
    await page.getByRole('button', { name: '我已安全备份，进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('wrong-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('alert')).toHaveText('口令错误，或本地验证材料已损坏。');
  });

  test('creates the first workspace before configuring its passphrase', async ({ page }) => {
    const state = { ...defaultState(), libraries: [], entries: [], entryById: {} };
    await mockWorkspace(page, state, { seedWorkspaceUnlock: false });
    await page.goto('/workspace');
    await expect(page.getByRole('heading', { name: '创建工作空间' })).toBeVisible();
    await page.getByLabel('工作空间名称').fill('课程资料库');
    await page.getByLabel('创建工作区口令').fill('first-workspace-secret');
    await page.getByLabel('再次输入口令').fill('first-workspace-secret');
    await page.getByRole('checkbox').check();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '创建并下载备份' }).click();
    expect((await downloadPromise).suggestedFilename()).toContain('课程资料库-passphrase.txt');
    await page.getByRole('button', { name: '我已安全备份，进入工作区' }).click();
    await expect(page.getByRole('button', { name: '课程资料库，0 个文件，0 个文件夹' })).toBeVisible();
  });

  test('campus tools keep local timetable and GPA separate from school data', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await expect(page.getByRole('heading', { name: '课程表' })).toBeVisible();
    await page.getByPlaceholder('例如：高等数学').fill('离散数学');
    await page.getByPlaceholder('教室（可选）').fill('教学楼 A101');
    await page.getByRole('button', { name: '添加到课表' }).click();
    await expect(page.locator('.campus-class').first()).toContainText('离散数学');
    await page.locator('.campus-sidebar-list').getByRole('button', { name: 'GPA', exact: true }).click();
    await page.getByPlaceholder('课程名').fill('离散数学');
    await page.getByRole('spinbutton', { name: '学分' }).fill('3');
    await page.getByRole('spinbutton', { name: '绩点（0–4）' }).fill('3.7');
    await page.getByRole('button', { name: '计入平均' }).click();
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('3.700');
    await page.reload();
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: 'GPA', exact: true }).click();
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('3.700');
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '课程表', exact: true }).click();
    await expect(page.locator('.campus-class').first()).toContainText('离散数学');
    await expect(page.locator('.workspace-tabs .workspace-tab')).toHaveCount(1);
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(page.locator('.workspace-tabs .workspace-tab')).toHaveCount(2);
  });

  test('campus vault stores only authenticated ciphertext and is identity scoped', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    await expect(page.getByText('入校码需要实时认证')).toBeVisible();
    await page.getByRole('button', { name: '绑定账号后获取' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) {
      await page.getByRole('button', { name: '更换绑定' }).click();
    }
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-secret-user');
    await page.getByLabel('微北洋密码').fill('campus-secret-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-secret-user');
    await page.getByLabel('办公网密码').fill('office-secret-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
    await expect(page.getByText('已绑定')).toBeVisible();
    const storage = await page.evaluate(() => localStorage.getItem('tjuclaw.campus.credentials.v1.user-identity-uuid-aaaa'));
    expect(storage).toBeTruthy();
    expect(storage).not.toContain('campus-secret-user');
    expect(storage).not.toContain('campus-secret-password');
    await page.reload();
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    await page.getByRole('button', { name: '解锁已绑定账号' }).click();
    await page.getByPlaceholder('输入独立解锁口令').fill('wrong-password');
    await page.getByRole('button', { name: '解锁并继续' }).click();
    await expect(page.getByRole('dialog').getByText('解锁失败：口令错误或本地数据已损坏。')).toBeVisible();
    await page.getByPlaceholder('输入独立解锁口令').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '解锁并继续' }).click();
    await expect(page.getByText('微北洋 campus-secret-user · 办公网 office-secret-user')).toBeVisible();
    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [{ ...guideB }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    await expect(page.getByRole('button', { name: '绑定微北洋与办公网账号' })).toBeVisible();
    await expect(page.getByText('campus-secret-user')).toHaveCount(0);
  });

  test('mobile tools float over the content and focus timer resumes on return', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开小工具' }).click();
    await expect(page.locator('.campus-sidebar-list')).toBeVisible();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '番茄时钟' }).click();
    await expect(page.locator('.campus-focus-clock')).toBeVisible();
    await page.getByRole('button', { name: '开始专注' }).click();
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '打开小工具' }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '番茄时钟' }).click();
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 380 } });
    await expect(page.locator('.obsidian-sidebar')).toHaveAttribute('aria-hidden', 'true');
    const viewportFits = await page.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight);
    expect(viewportFits).toBe(true);
  });

  test('sorts sidebar sections independently and persists manual order per identity', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = noteC;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const tree = page.locator('.obsidian-tree');
    const noteNames = () => tree.locator('.obsidian-tree-row .tree-item span').allTextContents();
    await expect.poll(noteNames).toEqual(['First note for user A', 'Second note for user A']);
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await page.getByRole('menuitemradio', { name: '名称 Z → A' }).click();
    await expect.poll(noteNames).toEqual(['Second note for user A', 'First note for user A']);
    await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: 'First note for user A', exact: true }) })
      .getByRole('button', { name: '文档操作' }).click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    await expect.poll(noteNames).toEqual(['First note for user A', 'Second note for user A']);
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await expect(page.getByRole('menuitemradio', { name: '手动排序' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: '名称 A → Z' }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await expect(page.getByRole('menuitemradio', { name: '手动排序' })).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('menuitemradio', { name: '手动排序' }).click();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await expect(page.getByRole('menuitemradio', { name: '最近修改' })).toHaveCount(0);
    await page.getByRole('menuitemradio', { name: '手动排序' }).click();
    await page.getByRole('button', { name: '资料夹', exact: true }).click();
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await page.getByRole('menuitemradio', { name: '手动排序' }).click();
    await expect.poll(noteNames).toEqual(['First note for user A', 'Second note for user A']);
    await page.reload();
    await expect.poll(noteNames).toEqual(['First note for user A', 'Second note for user A']);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [{ ...guideB }, { ...noteA, library_id: libB.id, title: 'Other note' }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(tree.getByRole('button', { name: 'Other note' })).toBeVisible();
    await page.getByRole('button', { name: '侧栏排序' }).click();
    await expect(page.getByRole('menuitemradio', { name: '手动排序' })).toHaveAttribute('aria-checked', 'true');
  });

  test('reorders notes by dragging an edge without moving them into a folder', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = noteC;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const tree = page.locator('.obsidian-tree');
    const first = tree.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: 'First note for user A', exact: true }) });
    const second = tree.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: 'Second note for user A', exact: true }) });
    await second.dragTo(first, { targetPosition: { x: 24, y: 2 } });
    await expect.poll(() => tree.locator('.obsidian-tree-row .tree-item span').allTextContents()).toEqual(['Second note for user A', 'First note for user A']);
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('资料');
    await page.locator('.tree-inline-input').press('Enter');
    const folder = tree.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) });
    await first.dragTo(folder, { targetPosition: { x: 50, y: 16 } });
    await expect(folder.locator('.tree-item span')).toHaveText('资料');
    await expect(tree.locator('.tree-children').getByRole('button', { name: 'First note for user A' })).toBeVisible();
  });

  test('offers touch-friendly order actions for plugins and keeps file moves separate', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '插件', exact: true }).click();
    const pluginList = page.locator('.obsidian-tree .sidebar-sort-row .session-tree-item span');
    await expect.poll(() => pluginList.allTextContents()).toEqual(['Markdown 编辑器', '知识图谱', '记忆闪卡']);
    await page.locator('.sidebar-sort-row').filter({ has: page.getByRole('button', { name: '知识图谱', exact: true }) }).getByRole('button', { name: '排序操作' }).click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    await expect.poll(() => pluginList.allTextContents()).toEqual(['知识图谱', 'Markdown 编辑器', '记忆闪卡']);
    await page.getByRole('button', { name: '资料夹', exact: true }).click();
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('资料');
    await page.locator('.tree-inline-input').press('Enter');
    await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) }).getByRole('button', { name: '文件夹操作' }).click();
    await page.getByRole('menuitem', { name: '新建笔记' }).click();
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect(page.locator('.obsidian-tree .tree-children').getByRole('button', { name: '未命名笔记' })).toBeVisible();
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await expect.poll(() => pluginList.allTextContents()).toEqual(['知识图谱', 'Markdown 编辑器', '记忆闪卡']);
    await page.reload();
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '插件', exact: true }).click();
    await expect.poll(() => pluginList.allTextContents()).toEqual(['知识图谱', 'Markdown 编辑器', '记忆闪卡']);
  });

  test('reorders Agents and flashcards without changing their data', async ({ page }) => {
    const state = defaultState();
    const otherAgent = { ...guideA, id: '33333333333333333333333333333333', title: '课程助手' };
    state.entries.push(otherAgent);
    state.entryById[otherAgent.id] = otherAgent;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const agentNames = page.locator('.obsidian-tree .sidebar-sort-row .session-tree-item span');
    await expect.poll(() => agentNames.allTextContents()).toEqual(['新手向导', '课程助手']);
    await page.locator('.obsidian-tree .sidebar-sort-row').nth(1).dragTo(page.locator('.obsidian-tree .sidebar-sort-row').nth(0), { targetPosition: { x: 20, y: 2 } });
    await expect.poll(() => agentNames.allTextContents()).toEqual(['课程助手', '新手向导']);
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '加载 4 张示例卡片' }).click();
    const cardNames = page.locator('.obsidian-tree .sidebar-sort-row .session-tree-item span');
    await expect(cardNames).toHaveCount(4);
    const original = await cardNames.allTextContents();
    await page.locator('.sidebar-sort-row').filter({ has: page.getByRole('button', { name: original[1], exact: true }) }).getByRole('button', { name: '排序操作' }).click();
    await page.getByRole('menuitem', { name: '上移' }).click();
    await expect.poll(() => cardNames.allTextContents()).toEqual([original[1], original[0], ...original.slice(2)]);
    await expect(page.locator('.anki-card')).toHaveCount(4);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect.poll(() => cardNames.allTextContents()).toEqual([original[1], original[0], ...original.slice(2)]);
  });

  test('reorders sibling folders without changing their parent', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    for (const name of ['课程', '资料']) {
      await page.getByRole('button', { name: '新建文件夹' }).click();
      await page.locator('.tree-inline-input').fill(name);
      await page.locator('.tree-inline-input').press('Enter');
    }
    const folderNames = page.locator('.obsidian-tree > .obsidian-tree-node > .obsidian-tree-row:has(.tree-toggle) .tree-item span');
    await expect.poll(() => folderNames.allTextContents()).toEqual(['课程', '资料']);
    const second = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: '资料', exact: true }) }).locator(':scope > .obsidian-tree-row');
    const first = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: '课程', exact: true }) }).locator(':scope > .obsidian-tree-row');
    await second.dragTo(first, { targetPosition: { x: 20, y: 2 } });
    await expect.poll(() => folderNames.allTextContents()).toEqual(['资料', '课程']);
    await expect(page.locator('.obsidian-tree > .obsidian-tree-node')).toHaveCount(3);
    await page.reload();
    await expect.poll(() => folderNames.allTextContents()).toEqual(['资料', '课程']);
  });

  test('keeps section tabs separate and replaces the current note with navigable history', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = noteC;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const tablist = page.getByRole('tablist', { name: '打开的标签页' });
    await expect(tablist.getByRole('tab', { name: '笔记 First note for user A' })).toBeVisible();
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(tablist.getByRole('tab', { name: '笔记 First note for user A' })).toBeVisible();
    await expect(tablist.getByRole('tab', { name: '笔记 新建笔记' }).last()).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '笔记 First note for user A' })).toHaveCount(0);
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(tablist.getByRole('tab', { name: '会话 新手向导' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(tablist.getByRole('tab', { name: '会话 新会话' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '新手向导', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '会话 新手向导' })).toHaveCount(2);
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '闪卡 记忆闪卡' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(tablist.getByRole('tab', { name: '闪卡 记忆闪卡' })).toHaveCount(2);
    await page.getByRole('button', { name: '资料夹', exact: true }).click();
    await tablist.getByRole('tab', { name: '笔记 First note for user A' }).click();
    await page.locator('.note-title').fill('修改后的标题');
    await expect(page.getByRole('button', { name: '上一个笔记' })).toBeDisabled();
    await page.getByRole('button', { name: 'Second note for user A', exact: true }).click();
    await expect(tablist.getByRole('tab')).toHaveCount(2);
    await expect(tablist.getByRole('tab', { name: '笔记 Second note for user A' })).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => state.entryById[noteA.id].title).toBe('修改后的标题');
    await page.getByRole('button', { name: '上一个笔记' }).click();
    await expect(page.locator('.note-title')).toHaveValue('修改后的标题');
    await page.getByRole('button', { name: '下一个笔记' }).click();
    await expect(page.locator('.note-title')).toHaveValue('Second note for user A');
    await tablist.getByRole('button', { name: '关闭标签 Second note for user A' }).click();
    await expect(tablist.getByRole('tab', { name: '笔记 新建笔记' })).toHaveCount(1);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '会话 新手向导' }).last()).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps a failed Agent message draft and renders a successful reply as Markdown', async ({ page }) => {
    const state = defaultState();
    state.sendError = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await expect(composer).toBeEnabled();
    await composer.fill('请解释主动回忆');
    await composer.press('Enter');
    await expect(page.getByRole('alert')).toContainText('草稿已保留');
    await expect(composer).toHaveValue('请解释主动回忆');
    state.sendError = false;
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.user')).toContainText('请解释主动回忆');
    await expect(page.locator('.chat-message.assistant strong')).toHaveText('已收到');
    await expect(composer).toHaveValue('');
  });

  test('loads sample flashcards only on request and exports them as Anki TSV', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();
    await page.getByRole('button', { name: '加载 4 张示例卡片' }).click();
    await expect(page.locator('.anki-card')).toHaveCount(4);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出 Anki' }).click();
    const file = await download;
    const content = await readFile(await file.path(), 'utf8');
    expect(content).toContain('什么是主动回忆？\t');
    expect(content.trim().split('\n')).toHaveLength(4);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.locator('.anki-card')).toHaveCount(4);
  });

  test('redirects to /auth/login when session is missing or 401', async ({ page }) => {
    await mockUnavailableLoginFlow(page);
    await page.route('**/api/auth/session', route => json(route, 401, { error: { id: 'session_required' } }));
    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('redirects to /auth/login when libraries API returns 401 session_required', async ({ page }) => {
    await mockUnavailableLoginFlow(page);
    let revoked = false;
    await page.route('**/api/auth/session', route => revoked
      ? json(route, 401, { error: { id: 'session_required' } })
      : json(route, 200, syntheticSessionA));
    await page.route('**/api/libraries', route => {
      revoked = true;
      return json(route, 401, { error: { id: 'session_required' } });
    });
    await page.goto('/workspace');
    await expect(page).toHaveURL(/\/auth\/login/);
  });

  test('clears in-memory notes when switching identity', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await expect(page.locator('.sidebar-library-button')).toContainText('我的知识库');
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();

    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [guideB];
    state.entryById = { [guideB.id]: guideB };
    state.sessionsByEntry = { [guideB.id]: [sessionB] };
    state.sessionById = { [sessionB.id]: sessionB };
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toHaveCount(0);
    await expect(page.locator('.note-title')).toHaveCount(0);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: '新手向导', exact: true })).toBeVisible();
  });

  test('keeps local folders and flashcards separate between identities', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('A 私有目录');
    await page.locator('.tree-inline-input').press('Enter');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '新建卡片' }).click();
    await page.getByPlaceholder('问题或提示').fill('A 的卡片');
    await page.locator('.sidebar-activity').getByRole('button', { name: '资料夹', exact: true }).click();

    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [guideB];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'A 私有目录' })).toHaveCount(0);
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByText('A 的卡片')).toHaveCount(0);
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();

    state.session = syntheticSessionA;
    state.libraries = [libA];
    state.entries = [guideA, noteA];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'A 私有目录' })).toBeVisible();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByRole('button', { name: 'A 的卡片' })).toBeVisible();
  });

  test('late creation response cannot restore a previous identity note', async ({ page }) => {
    const state = defaultState();
    let releaseCreate;
    state.holdCreate = new Promise(resolve => { releaseCreate = resolve; });
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [guideB];
    state.entryById = { [guideB.id]: guideB };
    state.sessionsByEntry = { [guideB.id]: [sessionB] };
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    releaseCreate();
    await expect(page.getByRole('button', { name: '未命名笔记', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toHaveCount(0);
  });

  test('preserves note text on save failure and allows retry', async ({ page }) => {
    const state = defaultState();
    state.patchError = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Private note body');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Edited body still here');
    await expect(page.locator('.workspace-error')).toContainText('保存失败');
    await expect(editor).toContainText('Edited body still here');
  });

  test('shows knowledge tree and guide without claiming execution', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await expect(page.locator('.sidebar-library-button')).toContainText('我的知识库');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(page.getByRole('textbox', { name: '发送给 Agent 的消息' })).toBeVisible();
    await expect(page.getByText('已保存 (draft)')).toHaveCount(0);
    await expect(page.getByText('执行记录与运行')).toHaveCount(0);
  });

  test('does not claim product NewAPI when fallback is missing', async ({ page }) => {
    const state = defaultState();
    state.model = { configured: false, source: 'none', quota: { limit: 20, used: 0, remaining: 20 } };
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(page.getByText('走产品 NewAPI')).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: '发送给 Agent 的消息' })).toBeVisible();
  });


  test('opens a new note immediately after creation', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(page.getByRole('button', { name: '未命名笔记', exact: true })).toBeVisible();
    await expect(page.locator('.note-title')).toHaveValue('未命名笔记');
  });

  test('starts with the mobile file pane closed and dismisses it with Escape or a note selection', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    const back = page.getByRole('button', { name: '上一个笔记' });
    const forward = page.getByRole('button', { name: '下一个笔记' });
    await expect(back).toBeVisible();
    await expect(forward).toBeVisible();
    await expect(back).toBeDisabled();
    const arrowBox = await back.boundingBox();
    const mainBox = await page.locator('.obsidian-main').boundingBox();
    const topbarBox = await page.locator('.obsidian-topbar').boundingBox();
    expect(Math.abs((arrowBox.x - mainBox.x) - (arrowBox.y - topbarBox.y - topbarBox.height))).toBeLessThan(6);
    const sidebar = page.locator('.obsidian-sidebar');
    await expect(sidebar).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect(sidebar).not.toHaveAttribute('inert');
    await expect(page.locator('.obsidian-main')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: 'First note for user A', exact: true }).click();
    await expect(sidebar).toHaveAttribute('inert', '');
  });

  test('expands the document when the desktop file pane closes', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    const main = page.locator('.obsidian-main');
    const before = await main.evaluate(element => element.getBoundingClientRect().width);
    await page.locator('.sidebar-pane-header').getByRole('button', { name: '收起侧栏' }).click();
    await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
    const after = await main.evaluate(element => element.getBoundingClientRect().width);
    expect(after).toBeGreaterThan(before + 200);
  });
});

for (const [width, height] of [[360, 800], [390, 844], [768, 1024], [1440, 900], [1920, 1080], [2560, 1440]]) {
  for (const theme of ['light', 'dark']) {
    test(`workspace layout ${width}x${height} ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await page.emulateMedia({ colorScheme: theme });
      await mockWorkspace(page, defaultState());
      await page.goto('/workspace');
      await expect(page.locator('.note-title')).toHaveValue('First note for user A');
      const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
      expect(horizontalOverflow).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
      if (width <= 720) await page.getByRole('button', { name: '打开侧栏' }).click();
      await expect(page.getByRole('button', { name: '设置' })).toBeVisible();
      await page.screenshot({
        path: `test-results/workspace/workspace-${width}x${height}-${theme}.png`,
        fullPage: true,
      });
    });
  }
}

test('desktop panes share scrollbars, scroll independently and resize from a quiet divider', async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = defaultState();
  state.entries[1] = { ...noteA, body: Array.from({ length: 100 }, (_, index) => `Paragraph ${index + 1}`).join('\n\n') };
  state.entryById[noteA.id] = state.entries[1];
  state.entries.push(...Array.from({ length: 40 }, (_, index) => ({
    ...noteA,
    id: (index + 10).toString(16).padStart(32, '0'),
    title: `Note ${index + 1}`,
  })));
  await mockWorkspace(page, state);
  await page.goto('/workspace');

  const tree = page.locator('.obsidian-tree');
  const editor = page.locator('.note-editor');
  await expect.poll(() => tree.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await expect.poll(() => editor.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await page.locator('.cm-content').click({ position: { x: 15, y: 15 } });
  await expect(page.getByRole('dialog', { name: 'Markdown 编辑菜单' })).toHaveCount(0);
  for (const scroller of [tree, editor, page.locator('.cm-scroller')]) {
    const visuals = await scroller.evaluate(element => {
      const style = part => getComputedStyle(element, part);
      return {
        width: style('::-webkit-scrollbar').width,
        track: style('::-webkit-scrollbar-track').backgroundColor,
        trackPiece: style('::-webkit-scrollbar-track-piece').backgroundColor,
        button: style('::-webkit-scrollbar-button').display,
        thumb: style('::-webkit-scrollbar-thumb').backgroundColor,
        border: style('::-webkit-scrollbar-thumb').borderLeftWidth,
        scrollbarWidth: getComputedStyle(element).scrollbarWidth,
      };
    });
    expect(visuals).toEqual({
      width: '11px',
      track: 'rgba(0, 0, 0, 0)',
      trackPiece: 'rgba(0, 0, 0, 0)',
      button: 'none',
      thumb: 'rgba(0, 0, 0, 0)',
      border: '2px',
      scrollbarWidth: 'auto',
    });
  }
  expect(await page.locator('.obsidian-app').evaluate(element => getComputedStyle(element).getPropertyValue('--scrollbar-visible-opacity'))).toBe('12%');
  await tree.hover();
  await page.mouse.wheel(0, 360);
  await expect.poll(() => tree.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(tree).toHaveAttribute('data-scroll-active', '');
  const treeScroll = await tree.evaluate(element => element.scrollTop);
  await editor.hover();
  await page.mouse.wheel(0, 360);
  await expect.poll(() => editor.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await expect(editor).toHaveAttribute('data-scroll-active', '');
  expect(await tree.evaluate(element => element.scrollTop)).toBe(treeScroll);
  expect(await page.evaluate(() => scrollY)).toBe(0);
  await page.screenshot({ path: info.outputPath('panes-scrollbars.png') });

  const sidebar = page.locator('.obsidian-sidebar');
  const left = page.getByRole('separator', { name: '调整左侧面板宽度' });
  const inactive = await left.evaluate(element => getComputedStyle(element, '::after').backgroundColor);
  const leftBox = await left.boundingBox();
  expect(leftBox.width).toBe(7);
  expect(leftBox.x + leftBox.width / 2).toBe(314);
  expect(await sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(314);
  expect(await page.locator('.sidebar-activity').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(48);
  expect(await page.locator('.obsidian-main').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(860);
  expect(await left.evaluate(element => getComputedStyle(element, '::after').width)).toBe('1px');
  await page.mouse.move(314, 200);
  await expect.poll(() => left.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).not.toBe(inactive);
  await page.mouse.down();
  await page.mouse.move(384, 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(384);

  if (await page.locator('.obsidian-app').evaluate(element => element.classList.contains('rail-collapsed'))) {
    await page.getByRole('button', { name: '切换信息栏' }).click();
  }
  const rail = page.locator('.obsidian-rail');
  const right = page.getByRole('separator', { name: '调整右侧面板宽度' });
  const rightBox = await right.boundingBox();
  expect(rightBox.x + rightBox.width / 2).toBe(1174);
  await page.mouse.move(1174, 200);
  await page.mouse.down();
  await page.mouse.move(1114, 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => rail.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(326);

  await page.getByRole('button', { name: '切换信息栏' }).click();
  await expect(right).toHaveCSS('pointer-events', 'none');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(left).toBeHidden();
  await expect(right).toBeHidden();
});

test('mobile note shell keeps navigation, actions and settings within one viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const state = defaultState();
  const body = '## 今日计划\n\n- 阅读 [[课程笔记]]\n- [ ] 整理资料\n\n### 下一步\n\n把摘录放进知识库。';
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeVisible();
  await expect(page.locator('.codemirror-editor .cm-md-syntax')).toHaveCount(0);
  await page.locator('.codemirror-editor .cm-line').first().click();
  await expect(page.locator('.codemirror-editor .cm-md-syntax')).toHaveCount(1);
  await page.getByRole('button', { name: '打开侧栏' }).focus();
  await expect(page.locator('.codemirror-editor .cm-md-syntax')).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace/mobile-note-shell.png' });

  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.getByRole('button', { name: '收起侧栏' }).first()).toBeVisible();
  await page.getByRole('button', { name: '新建文件夹' }).click();
  await page.locator('.tree-inline-input').fill('资料');
  await page.locator('.tree-inline-input').press('Enter');
  await expect(page.getByRole('button', { name: '资料', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-file-drawer.png' });
  await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) }).getByRole('button', { name: '文件夹操作' }).click();
  await expect(page.getByRole('menu', { name: '文档操作' })).toBeVisible();
  await page.getByRole('button', { name: '关闭操作菜单' }).click();
  await page.getByRole('button', { name: 'First note for user A', exact: true }).click();
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);

  await page.getByRole('button', { name: '更多操作' }).click();
  await expect(page.getByRole('menu', { name: '文档操作' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-actions.png' });
  await page.getByRole('menuitem', { name: '大纲' }).click();
  await expect(page.locator('.obsidian-rail').getByRole('button', { name: '今日计划' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-outline.png' });
  await page.locator('.obsidian-rail').getByRole('button', { name: '今日计划' }).click();
  await expect(page.locator('.obsidian-app')).toHaveClass(/rail-collapsed/);
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  await expect(page.getByRole('dialog', { name: '移动到' })).toBeVisible();
  await page.getByRole('button', { name: /资料/ }).last().click();
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.locator('.tree-children').getByRole('button', { name: 'First note for user A' })).toBeVisible();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-settings.png' });
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.keyboard.press('Escape');
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
  expect(errors).toEqual([]);
});

test('mobile sidebar keeps the desktop activity rail on the left with motion-aware dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  const sidebar = page.locator('.obsidian-sidebar');
  const rail = sidebar.locator('.sidebar-activity');
  const notes = rail.getByRole('button', { name: '资料夹' });
  const positions = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    return {
      rail: rect('.sidebar-activity').toJSON(),
      pane: rect('.sidebar-pane').toJSON(),
      notes: rect('.sidebar-activity .activity-main button').toJSON(),
      settings: rect('.sidebar-activity .activity-settings').toJSON(),
    };
  });
  expect(positions.rail.right).toBeLessThanOrEqual(positions.pane.left + 1);
  expect(positions.rail.height).toBeGreaterThan(650);
  expect(positions.notes.y).toBeLessThan(positions.settings.y - 450);
  await expect(notes).toHaveAttribute('aria-current', 'page');
  await expect(rail.locator('.activity-current-mark')).toHaveCount(1);
  await rail.getByRole('button', { name: 'Agent' }).click();
  await expect(rail.getByRole('button', { name: 'Agent' })).toHaveAttribute('aria-current', 'page');
  await expect(rail.locator('.activity-current-mark')).toHaveCount(1);
  await notes.click();
  await page.screenshot({ path: 'test-results/workspace/mobile-left-rail.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/workspace/mobile-left-rail-dark.png' });
  await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 350 } });
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await expect(page.locator('.mobile-sidebar-backdrop')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
});

test('plugin directory opens real built-in features without claiming external installation', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  const activity = page.locator('.sidebar-activity');
  await activity.getByRole('button', { name: '插件' }).click();
  await expect(page.getByRole('heading', { name: 'Markdown 编辑器' })).toBeVisible();
  await expect(page.getByText('第三方插件尚未开放').first()).toBeVisible();
  await page.locator('.obsidian-tree').getByRole('button', { name: '知识图谱' }).click();
  await page.getByRole('button', { name: '打开知识图谱' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.obsidian-tree').getByRole('button', { name: '记忆闪卡' }).click();
  await page.getByRole('button', { name: '打开记忆闪卡' }).click();
  await expect(page.getByRole('heading', { name: '记忆闪卡', exact: true })).toBeVisible();
  await expect(activity.getByRole('button', { name: '记忆闪卡' })).toHaveAttribute('aria-current', 'page');
});

test('mobile plugin selection closes the drawer and keeps page scrolling internal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.locator('.sidebar-activity').getByRole('button', { name: '插件' }).click();
  await page.locator('.obsidian-tree').getByRole('button', { name: '知识图谱' }).click();
  await expect(page.locator('.obsidian-sidebar')).toHaveAttribute('inert', '');
  await expect(page.getByRole('button', { name: '打开知识图谱' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
});

test('reduced motion keeps the mobile drawer operable without a transition', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(page.locator('.obsidian-sidebar')).toBeInViewport();
  await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 350 } });
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.mobile-sidebar-backdrop')).toHaveCount(0);
});

test('desktop workspace expands the document when the file pane closes', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  await page.screenshot({ path: 'test-results/workspace/desktop-note-shell.png' });
  const before = await page.locator('.obsidian-main').evaluate(element => element.getBoundingClientRect().width);
  await page.getByRole('button', { name: '收起侧栏' }).first().click();
  const after = await page.locator('.obsidian-main').evaluate(element => element.getBoundingClientRect().width);
  expect(after).toBeGreaterThan(before + 200);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
});

test('tablet note does not reserve space for a hidden outline', async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  await expect(page.locator('.obsidian-app')).toHaveClass(/rail-collapsed/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('live Markdown preview reveals only the construct being edited and keeps source intact', async ({ page }) => {
  const state = defaultState();
  const body = [
    '# 标题',
    '',
    '正文 **粗体和 *斜体***、~~删除线~~、`代码`、[链接](https://example.com) 与 [[目标|别名]]。',
    '',
    '- [ ] 待办任务',
    '- 普通列表',
    '',
    '> 引用文本',
    '',
    '```md',
    '**代码块原样保留**',
    '```',
  ].join('\n');
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/workspace');

  const editor = page.locator('.codemirror-editor');
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(0);
  await expect(editor.locator('.cm-md-heading-line')).toContainText('标题');
  await expect(editor.locator('.cm-md-strong')).toContainText('粗体和');
  await expect(editor.locator('.cm-md-emphasis')).toContainText('斜体');
  await expect(editor.locator('.cm-md-strikethrough')).toContainText('删除线');
  await expect(editor.locator('.cm-md-wikilink')).toHaveText('别名');
  await expect(editor.locator('.cm-md-code-line')).toHaveCount(3);
  await expect(editor.locator('.cm-md-strong')).toHaveCount(1);
  const headingHeight = await editor.locator('.cm-md-heading-line').evaluate(element => element.getBoundingClientRect().height);
  const paragraphHeight = await editor.locator('.cm-md-strong').evaluate(element => element.closest('.cm-line').getBoundingClientRect().height);
  expect(headingHeight).toBeGreaterThan(paragraphHeight);

  await editor.locator('.cm-md-strong').click();
  await expect(editor.locator('.cm-md-syntax').first()).toBeVisible();
  await page.keyboard.press('End');
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(0);
  await page.keyboard.press('Home');
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(0);
  for (let index = 0; index < 3; index++) await page.keyboard.press('ArrowRight');
  await expect(editor.locator('.cm-md-syntax').first()).toBeVisible();
  await editor.locator('.cm-md-wikilink').click();
  await expect(editor.locator('.cm-md-syntax').first()).toBeVisible();
  await editor.locator('.cm-md-heading-line').click();
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(1);
  await page.getByRole('button', { name: '切换信息栏' }).focus();
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(0);

  await editor.locator('.cm-md-checkbox').check();
  await expect.poll(() => state.entryById[noteA.id].body).toContain('- [x] 待办任务');
  await expect(editor.locator('.cm-md-checkbox')).toBeChecked();
  await editor.locator('.cm-md-checkbox').focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => state.entryById[noteA.id].body).toContain('- [ ] 待办任务');
  await expect(editor.locator('.cm-md-checkbox')).not.toBeChecked();
  await page.screenshot({ path: 'test-results/workspace/markdown-live-preview.png' });
  expect(errors).toEqual([]);
});

test('block Markdown markers include their separating spaces in live preview', async ({ page }) => {
  const state = defaultState();
  const body = '##  标题\n\n>  引用\n\n-  列表\n\n1.  顺序\n\n- [ ]  待办';
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor');
  const heading = editor.locator('.cm-md-heading-line');
  const quote = editor.locator('.cm-md-quote-line');
  const bullet = editor.locator('.cm-line').filter({ hasText: '列表' });
  const ordered = editor.locator('.cm-line').filter({ hasText: '顺序' });
  const task = editor.locator('.cm-line').filter({ hasText: '待办' });

  expect(await heading.textContent()).toBe('标题');
  expect(await quote.textContent()).toBe('引用');
  expect(await bullet.textContent()).toBe('•列表');
  expect(await ordered.locator('.cm-md-ordered-marker').textContent()).toBe('1.  ');
  expect(await task.textContent()).toBe('待办');

  await heading.click();
  expect(await heading.locator('.cm-md-syntax').textContent()).toBe('##  ');
  await quote.click();
  expect(await quote.locator('.cm-md-syntax').textContent()).toBe('>  ');
  await bullet.click();
  expect(await bullet.locator('.cm-md-syntax').textContent()).toBe('-  ');
  await expect.poll(() => state.entryById[noteA.id].body).toBe(body);
});

test('typing a Markdown heading keeps the marker legible without underlining the heading', async ({ page }) => {
  const state = defaultState();
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body: '' } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body: '' };
  await mockWorkspace(page, state);
  await page.goto('/workspace');

  const editor = page.locator('.codemirror-editor .cm-content');
  await editor.click();
  await page.keyboard.type('#');
  await expect(editor.locator('.cm-line')).toHaveText('#');
  const loneMarker = await editor.locator('.cm-line').evaluate(line => ({
    decorated: [line, ...line.querySelectorAll('*')].filter(element => getComputedStyle(element).textDecorationLine.includes('underline')).map(element => element.className),
    font: getComputedStyle(line).fontFamily,
  }));
  expect(loneMarker.decorated).toEqual([]);
  expect(loneMarker.font).toContain('Cascadia Code');
  expect(loneMarker.font).toContain('LXGW WenKai');
  await expect(page.locator('.codemirror-editor .cm-scroller')).toHaveCSS('font-family', /Cascadia Code.*LXGW WenKai/);
  await expect(editor).toHaveAttribute('spellcheck', 'false');
  await page.keyboard.type(' ');
  await expect(editor.locator('.cm-line')).toHaveText('# ');
  expect(await editor.locator('.cm-line').evaluate(line =>
    [line, ...line.querySelectorAll('*')].some(element => getComputedStyle(element).textDecorationLine.includes('underline'))
  )).toBe(false);
  await page.keyboard.type('标题');
  await expect(editor.locator('.cm-md-heading-line')).toHaveText('# 标题');
  const styles = await editor.locator('.cm-md-heading-line').evaluate(line => {
    const marker = line.querySelector('.cm-md-syntax');
    return {
      decorated: [line, ...line.querySelectorAll('*')].filter(element => getComputedStyle(element).textDecorationLine.includes('underline')).map(element => element.className),
      markerColor: marker ? getComputedStyle(marker).color : null,
      background: getComputedStyle(line).backgroundColor,
    };
  });
  expect(styles.decorated).toEqual([]);
  expect(styles.markerColor).not.toBeNull();
  await expect(editor.locator('.cm-md-heading-line .cm-md-syntax').first()).toHaveCSS('font-weight', '700');
  const markerContrast = await editor.locator('.cm-md-syntax').first().evaluate(element => {
    const ink = getComputedStyle(element).color;
    const body = getComputedStyle(element.closest('.cm-line')).color;
    return { ink, body };
  });
  expect(markerContrast.ink).not.toBe(markerContrast.body);
  const markerVisibility = await editor.locator('.cm-md-syntax').first().evaluate(element => {
    const rgb = (color) => {
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 1, 1);
      return [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
    };
    const luminance = (color) => rgb(color).map(value => {
      const channel = value / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((total, value, index) => total + value * [0.2126, 0.7152, 0.0722][index], 0);
    const foreground = luminance(getComputedStyle(element).color);
    const body = luminance(getComputedStyle(element.closest('.cm-line')).color);
    const background = luminance(getComputedStyle(element.closest('.cm-line')).backgroundColor === 'rgba(0, 0, 0, 0)' ? getComputedStyle(document.documentElement).getPropertyValue('--surface') : getComputedStyle(element.closest('.cm-line')).backgroundColor);
    return {
      readability: (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
      separation: Math.abs(foreground - body),
    };
  });
  expect(markerVisibility.readability).toBeGreaterThanOrEqual(10);
  expect(markerVisibility.separation).toBeGreaterThanOrEqual(0.02);
  const markerSize = await editor.locator('.cm-md-heading-line').evaluate(line => ({
    marker: getComputedStyle(line.querySelector('.cm-md-syntax')).fontSize,
    heading: getComputedStyle(line).fontSize,
  }));
  expect(markerSize.marker).toBe(markerSize.heading);
  await page.getByRole('button', { name: '切换信息栏' }).focus();
  await expect(editor.locator('.cm-md-syntax')).toHaveCount(0);
  await expect(editor.locator('.cm-md-heading-line')).not.toHaveCSS('text-decoration-line', 'underline');
  await editor.locator('.cm-md-heading-line').click();
  await expect(editor.locator('.cm-md-syntax').first()).toHaveCSS('text-decoration-line', 'none');
  const fontFaces = await page.evaluate(async () => {
    const [latin, chinese] = await Promise.all([
      document.fonts.load('400 16px "Cascadia Code"', 'ABC#'),
      document.fonts.load('400 16px "LXGW WenKai"', '中文'),
    ]);
    return { latin: latin.length, chinese: chinese.length };
  });
  expect(fontFaces.latin).toBeGreaterThan(0);
  expect(fontFaces.chinese).toBeGreaterThan(0);
  const latinCoverage = await page.evaluate(() => [...document.fonts].some(face =>
    face.family === 'Cascadia Code' && face.weight === '400' && face.unicodeRange.includes('U+0-FF')
  ));
  expect(latinCoverage).toBe(true);
  await page.keyboard.type(' [链接](https://example.com)');
  await expect(editor.locator('.cm-md-link-label')).toHaveCSS('text-decoration-line', 'underline');
  const linkSyntax = await editor.locator('.cm-md-syntax').filter({ hasText: 'https://example.com' }).evaluate(element => ({
    markerColor: getComputedStyle(element).color,
    nestedColors: [...element.querySelectorAll('*')].map(child => getComputedStyle(child).color),
  }));
  expect(linkSyntax.nestedColors.every(color => color === linkSyntax.markerColor)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace/heading-markers-fonts.png' });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await expect(editor.locator('.cm-md-heading-line .cm-md-syntax').first()).toHaveCSS('text-decoration-line', 'none');
  await expect(editor.locator('.cm-md-link-label')).toHaveCSS('text-decoration-line', 'underline');
  await page.screenshot({ path: 'test-results/workspace/heading-markers-fonts-dark.png' });
});

test('inactive list bullets remain readable beside Markdown syntax', async ({ page }) => {
  const state = defaultState();
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body: '# 标题\n\n- 列表项' } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body: '# 标题\n\n- 列表项' };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  await expect(editor.locator('.cm-md-bullet')).toBeVisible();
  await editor.locator('.cm-md-heading-line').click();
  const contrast = await editor.locator('.cm-md-bullet').evaluate(element => ({
    bullet: getComputedStyle(element).color,
    marker: getComputedStyle(element.closest('.cm-content').querySelector('.cm-md-syntax')).color,
  }));
  expect(contrast.bullet).toBe(contrast.marker);
});

test('editor right-click menu formats selections and lines without losing undo history', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  const menu = page.getByRole('dialog', { name: 'Markdown 编辑菜单' });
  await expect(menu).toHaveCount(0);
  await editor.click();
  await expect(menu).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+a');
  await editor.click({ button: 'right', position: { x: 30, y: 12 } });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox()).width).toBeLessThanOrEqual(286);
  expect((await menu.boundingBox()).height).toBeLessThanOrEqual(392);
  await expect(page.getByRole('toolbar', { name: 'Markdown 格式工具栏' })).toHaveCount(0);
  await menu.getByRole('button', { name: '加粗' }).click();
  await expect(editor).toContainText('Private note body');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('**Private note body**');
  await expect(menu).toHaveCount(0);
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '加粗' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '标题 2' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## Private note body');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '正文' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '撤销' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## Private note body');
  await page.keyboard.press('ControlOrMeta+a');
  await editor.click({ button: 'right' });
  await menu.getByRole('textbox', { name: '查找 Markdown 命令' }).fill('双向链接');
  await expect(menu.getByRole('button', { name: '双向链接' })).toBeVisible();
  await page.keyboard.press('Enter');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## [[Private note body]]');
  await editor.click({ button: 'right' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(editor).toBeFocused();
  await page.keyboard.press('Shift+F10');
  await expect(menu).toBeVisible();
  await expect(menu).toBeInViewport();
  await page.keyboard.press('Escape');
});

test('Markdown context menu cuts and pastes the selected source text', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.evaluate(() => {
    let clipboard = '';
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async text => { clipboard = text; },
        readText: async () => clipboard,
      },
    });
  });
  const editor = page.locator('.codemirror-editor .cm-content');
  const menu = page.getByRole('dialog', { name: 'Markdown 编辑菜单' });
  await editor.click();
  await page.keyboard.press('ControlOrMeta+a');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '剪切' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '粘贴', exact: true }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
});

test('context options and note rows keep hover and selection colors aligned', async ({ page }) => {
  const state = defaultState();
  const other = { ...noteA, id: '33333333333333333333333333333333', title: 'Other note' };
  state.entries.push(other);
  state.entryById[other.id] = other;
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  for (const theme of ['light', 'dark']) {
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const selectedRow = page.locator('.obsidian-tree-row.is-active');
    const otherRow = page.locator('.obsidian-tree-row').filter({ hasText: 'Other note' });
    const selectedColor = await selectedRow.evaluate(element => getComputedStyle(element).backgroundColor);
    const selectedBounds = await selectedRow.boundingBox();
    const otherBounds = await otherRow.boundingBox();
    expect(otherBounds.y - selectedBounds.y - selectedBounds.height).toBeGreaterThanOrEqual(1);
    expect(otherBounds.y - selectedBounds.y - selectedBounds.height).toBeLessThanOrEqual(3);
    await otherRow.hover();
    expect(await otherRow.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(selectedColor);
    await selectedRow.hover();
    expect(await selectedRow.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(selectedColor);

    await page.locator('.codemirror-editor .cm-content').click({ button: 'right' });
    const menu = page.getByRole('dialog', { name: 'Markdown 编辑菜单' });
    const active = menu.getByRole('button', { name: '加粗' });
    const next = menu.getByRole('button', { name: '斜体' });
    const activeColor = await active.evaluate(element => getComputedStyle(element).backgroundColor);
    const activeBounds = await active.boundingBox();
    const nextBounds = await next.boundingBox();
    expect(nextBounds.y - activeBounds.y - activeBounds.height).toBe(2);
    await next.hover();
    expect(await next.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(activeColor);
    expect(activeColor).not.toBe('rgba(0, 0, 0, 0)');
    await page.keyboard.press('Escape');
  }
});

test('mobile Markdown commands appear as a scrollable sheet instead of a permanent toolbar', async ({ page }) => {
  const state = defaultState();
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  await editor.click();
  await expect(page.getByRole('dialog', { name: 'Markdown 编辑菜单' })).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeVisible();
  await editor.click({ button: 'right' });
  const menu = page.getByRole('dialog', { name: 'Markdown 编辑菜单' });
  await expect(menu).toBeVisible();
  expect((await menu.boundingBox()).height).toBeLessThanOrEqual(844 * .55);
  await menu.getByRole('button', { name: '任务列表' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('- [ ] Private note body');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await editor.click({ button: 'right' });
  await page.screenshot({ path: 'test-results/workspace/mobile-markdown-menu.png' });
  await page.getByRole('button', { name: '关闭 Markdown 菜单' }).click({ position: { x: 10, y: 10 } });
  await expect(menu).toHaveCount(0);
});

test('long-press opens Markdown commands on touch and moving cancels the gesture', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await editor.tap();
    const menu = page.getByRole('dialog', { name: 'Markdown 编辑菜单' });
    await expect(menu).toHaveCount(0);
    const box = await editor.boundingBox();
    const point = { pointerType: 'touch', clientX: box.x + 35, clientY: box.y + 20 };
    await editor.dispatchEvent('pointerdown', point);
    await editor.dispatchEvent('pointermove', { ...point, clientX: point.clientX + 30 });
    await page.waitForTimeout(550);
    await expect(menu).toHaveCount(0);
    await editor.dispatchEvent('pointerdown', point);
    await expect(menu).toBeVisible();
    await editor.dispatchEvent('pointerup', point);
    await menu.getByRole('button', { name: '无序列表' }).tap();
    await expect.poll(() => state.entryById[noteA.id].body).toBe('- Private note body');
    await expect(menu).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('switching notes does not carry the cursor or undo history into another note', async ({ page }) => {
  const state = defaultState();
  const secondNote = {
    ...noteA,
    id: '33333333333333333333333333333333',
    title: 'Second note',
    body: 'Only the second note',
  };
  state.entries.push(secondNote);
  state.entryById[secondNote.id] = secondNote;
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' changed');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body changed');
  await page.getByRole('button', { name: 'Second note' }).click();
  await expect(editor).toHaveText('Only the second note');
  await editor.click();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(editor).toHaveText('Only the second note');
  expect(state.entryById[secondNote.id].body).toBe('Only the second note');
});

test('the full Markdown fixture stays editable within its pane', async ({ page }) => {
  const state = defaultState();
  const body = await readFile(new URL('../src/fixtures/markdown-feature-test.md', import.meta.url), 'utf8');
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/workspace');
  await expect(page.locator('.codemirror-editor .cm-md-heading-line').first()).toContainText('Markdown 全功能压力测试');
  await page.locator('.codemirror-editor .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await expect(page.locator('.codemirror-editor .cm-line').filter({ hasText: '最后再留一个链接' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  await page.getByRole('button', { name: '阅读模式' }).last().click();
  expect(await page.locator('.markdown-preview table').count()).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('library entry shows live note and folder counts and opens file settings', async ({ page }) => {
  const state = defaultState();
  state.entries.push({ ...noteA, id: '44444444444444444444444444444444', kind: 'file', title: 'diagram.png', body: undefined });
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const libraryButton = page.locator('.sidebar-library-button');
  await expect(libraryButton).toContainText('2 个文件 · 0 个文件夹');
  await page.getByRole('button', { name: '新建文件夹' }).click();
  await expect(libraryButton).toContainText('2 个文件 · 1 个文件夹');
  await libraryButton.click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '资料夹与链接' })).toBeVisible();
  await expect(page.getByRole('dialog').getByText('2', { exact: true })).toHaveCount(1);
  await expect(page.getByRole('dialog').getByText('1', { exact: true })).toHaveCount(2);
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '外观' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/settings-desktop.png' });
  await page.getByRole('group', { name: '配色模式' }).getByRole('button', { name: '深色' }).click();
  await page.screenshot({ path: 'test-results/workspace/settings-desktop-dark.png' });
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
  await expect(page.getByText(syntheticSessionA.email)).toBeVisible();
});

test('graph links notes by wikilink title and opens its node', async ({ page }) => {
  const state = defaultState();
  const second = { ...noteA, id: '33333333333333333333333333333333', title: 'Second note', body: 'Backlink' };
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body: '[[Second note]]' } : entry).concat(second);
  state.entryById[noteA.id] = { ...noteA, body: '[[Second note]]' };
  state.entryById[second.id] = second;
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '知识图谱' }).click();
  await expect(page.getByRole('dialog').getByText('2 篇笔记 · 1 条双向链接')).toBeVisible();
  await expect(page.locator('.graph-edge')).toHaveCount(1);
  await page.getByRole('button', { name: '打开笔记 Second note' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue('Second note');
});

test('mobile settings and graph stay inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/settings-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.getByRole('button', { name: '知识图谱' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '知识图谱' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

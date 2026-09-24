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
    holdCreate: null,
  };
}

async function mockWorkspace(page, state) {
  await page.route('**/api/**', async route => {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname.replace(/\/$/, '');
    if (path === '/api/auth/session') return json(route, 200, state.session);
    if (path === '/api/libraries' && method === 'GET') return json(route, 200, { libraries: state.libraries });
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
    await expect(page.getByRole('button', { name: 'First note for user A' })).toBeVisible();

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
    await expect(page.getByRole('button', { name: 'First note for user A' })).toHaveCount(0);
    await expect(page.locator('.note-title')).toHaveCount(0);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: '新手向导' })).toBeVisible();
  });

  test('keeps local folders and flashcards separate between identities', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await expect(page.getByRole('button', { name: 'First note for user A' })).toBeVisible();
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
    await expect(page.getByRole('button', { name: 'First note for user A' })).toHaveCount(0);
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
    await expect(page.getByRole('button', { name: 'First note for user A' })).toBeVisible();
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
    await expect(page.getByRole('button', { name: '未命名笔记' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'First note for user A' })).toHaveCount(0);
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
    await expect(page.getByRole('textbox', { name: '输入消息，按 Enter 发送...' })).toBeVisible();
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
    await expect(page.getByRole('textbox', { name: '输入消息，按 Enter 发送...' })).toBeVisible();
  });


  test('opens a new note immediately after creation', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '新建笔记', exact: true }).click();
    await expect(page.getByRole('button', { name: '未命名笔记' })).toBeVisible();
    await expect(page.locator('.note-title')).toHaveValue('未命名笔记');
  });

  test('starts with the mobile file pane closed and dismisses it with Escape or a note selection', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    const sidebar = page.locator('.obsidian-sidebar');
    await expect(sidebar).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect(sidebar).not.toHaveAttribute('inert');
    await expect(page.locator('.obsidian-main')).toHaveAttribute('inert', '');
    await page.keyboard.press('Escape');
    await expect(sidebar).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: 'First note for user A' }).click();
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
  await page.getByRole('button', { name: 'First note for user A' }).click();
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

test('focused Markdown toolbar formats selections and lines without losing the cursor', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  const toolbar = page.getByRole('toolbar', { name: 'Markdown 格式工具栏' });
  await expect(toolbar).toHaveCount(0);
  await editor.click();
  await expect(toolbar).toBeVisible();
  await page.keyboard.press('ControlOrMeta+a');
  await toolbar.getByRole('button', { name: '加粗' }).click();
  await expect(editor).toContainText('Private note body');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('**Private note body**');
  await expect(toolbar).toBeVisible();
  await toolbar.getByRole('button', { name: '加粗' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  await toolbar.getByRole('button', { name: '标题' }).click();
  await toolbar.getByRole('menuitem', { name: '标题 2' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## Private note body');
  await toolbar.getByRole('button', { name: '标题' }).click();
  await toolbar.getByRole('menuitem', { name: '正文' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  await toolbar.getByRole('button', { name: '撤销' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## Private note body');
  await page.keyboard.press('ControlOrMeta+a');
  await toolbar.getByRole('button', { name: '双向链接' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('[[## Private note body]]');
  await page.getByRole('button', { name: '切换信息栏' }).focus();
  await expect(toolbar).toHaveCount(0);
});

test('mobile editing replaces bottom navigation with a scrollable keyboard-aware Markdown toolbar', async ({ page }) => {
  const state = defaultState();
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor .cm-content');
  await editor.click();
  const toolbar = page.getByRole('toolbar', { name: 'Markdown 格式工具栏' });
  await expect(toolbar).toBeVisible();
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeHidden();
  await expect(page.getByRole('button', { name: '收起键盘' })).toBeVisible();
  await toolbar.getByRole('button', { name: '任务列表' }).click({ force: true });
  await expect.poll(() => state.entryById[noteA.id].body).toBe('- [ ] Private note body');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  await page.screenshot({ path: 'test-results/workspace/mobile-markdown-toolbar.png' });
});

test('touching a Markdown command retains the active mobile editor', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.locator('.codemirror-editor .cm-content').tap();
    const toolbar = page.getByRole('toolbar', { name: 'Markdown 格式工具栏' });
    await expect(toolbar).toBeVisible();
    await toolbar.getByRole('button', { name: '无序列表' }).tap();
    await expect.poll(() => state.entryById[noteA.id].body).toBe('- Private note body');
    await expect(toolbar).toBeVisible();
    await page.getByRole('button', { name: '收起键盘' }).tap();
    await expect(toolbar).toHaveCount(0);
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

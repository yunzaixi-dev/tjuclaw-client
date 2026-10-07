import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { strToU8, zipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { createEdgeoneConfig } from './edgeone-config.mjs';

function obsidianState() {
  const state = defaultState();
  const course = { ...createdNote, id: '12121212121212121212121212121212', kind: 'folder', title: '课程' };
  const chapter = { ...course, id: '13131313131313131313131313131313', parent_id: course.id, title: '章节' };
  const assets = { ...course, id: '14141414141414141414141414141414', parent_id: course.id, title: 'assets' };
  const target = { ...noteC, parent_id: course.id, title: '复习', body: '# 开始\n\n' + '合成测试正文。\n\n'.repeat(50) + '## 重点\n\n目标正文。' };
  const image = { ...createdNote, id: '15151515151515151515151515151515', kind: 'file', parent_id: assets.id, title: '图 #1.png', content_type: 'image/png', size: 68 };
  const source = { ...noteA, parent_id: chapter.id, body: [
    '[[课程/复习#重点|去复习]]',
    '[相对链接](../复习.md)',
    '![课程图片](../assets/%E5%9B%BE%20%231.png)',
    '![[课程/assets/图 %231.png|80]]',
    '`[[课程/复习|不跳转]]`',
    '```md\n[[课程/复习|代码内不跳转]]\n```',
  ].join('\n\n') };
  state.entries = [guideA, source, target, course, chapter, assets, image];
  state.entryById = Object.fromEntries(state.entries.map(entry => [entry.id, entry]));
  return { state, source, target, image };
}

test('Obsidian live preview opens wiki and relative note links and loads original attachments', async ({ page }) => {
  const { state, source, target, image } = obsidianState();
  await mockWorkspace(page, state);
  const requested = [];
  await page.route('**/api/entries/**/file', route => {
    requested.push(route.request().url().split('/').at(-2));
    return route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64') });
  });
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor');
  await expect(editor.locator('img.cm-md-image')).toHaveCount(2);
  for (const img of await editor.locator('img.cm-md-image').all()) {
    await expect(img).toHaveAttribute('src', `/api/entries/${image.id}/file`);
    await expect.poll(() => img.evaluate(node => node.naturalWidth)).toBe(1);
  }
  await expect(editor.locator('img.cm-md-image[width="80"]')).toHaveCount(1);
  await expect(editor.locator('.cm-md-wikilink')).toHaveCount(1);
  await editor.getByRole('link', { name: '去复习' }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(target.title);
  await expect(editor.locator('.cm-md-heading-line').filter({ hasText: '重点' })).toBeInViewport();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole('button', { name: '上一个笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(source.title);
  await editor.getByRole('link', { name: '相对链接' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(target.title);
  expect(requested.every(id => id === image.id)).toBe(true);
  expect(state.entryById[source.id].body).toBe(source.body);
});

for (const mode of ['edit', 'preview']) {
  test(`Obsidian ${mode} refreshes attachments when the full library replaces its cached tree`, async ({ page }) => {
    const { state, source, image } = obsidianState();
    await mockWorkspace(page, state);
    await page.route('**/api/entries/**/file', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64') }));
    await page.goto('/workspace');
    await expect(page.locator('img.cm-md-image')).toHaveCount(2);
    await page.evaluate(({ owner, sourceId, imageId }) => {
      const key = `tjuclaw.workspace-tree.v1.${owner}`;
      const tree = JSON.parse(localStorage.getItem(key));
      tree.entries = tree.entries.filter(entry => entry.id !== imageId);
      tree.focus = sourceId;
      localStorage.setItem(key, JSON.stringify(tree));
    }, { owner: syntheticSessionA.id, sourceId: source.id, imageId: image.id });
    let release;
    const ready = new Promise(resolve => { release = resolve; });
    await page.route(`**/api/libraries/${libA.id}/entries`, async route => {
      await ready;
      return json(route, 200, { entries: state.entries });
    });
    await page.reload();
    await expect(page.locator('.cm-md-image-card')).toHaveCount(1);
    if (mode === 'preview') await page.getByRole('button', { name: '阅读模式' }).click();
    release();
    const images = page.locator(mode === 'edit' ? 'img.cm-md-image' : '.note-reader img');
    await expect(page.locator('.obsidian-tree').getByRole('button', { name: image.title, exact: true })).toBeVisible();
    await expect(images).toHaveCount(2);
    for (const img of await images.all()) await expect.poll(() => img.evaluate(node => node.naturalWidth)).toBe(1);
    expect(state.entryById[source.id].body).toBe(source.body);
  });
}

test.describe('Obsidian touch links', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  test('a note link opens with a tap without editing its source', async ({ page }) => {
    const { state, source, target } = obsidianState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.locator('.codemirror-editor').getByRole('link', { name: '去复习' }).tap();
    await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(target.title);
    expect(state.entryById[source.id].body).toBe(source.body);
  });
});

test('Obsidian reading links stay in the workspace, jump to headings, and leave code untouched', async ({ page }) => {
  const { state, source, target, image } = obsidianState();
  await mockWorkspace(page, state);
  await page.route('**/api/entries/**/file', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64') }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '阅读模式' }).click();
  const reader = page.getByRole('region', { name: '阅读' });
  await expect(reader.locator('img')).toHaveCount(2);
  for (const img of await reader.locator('img').all()) {
    await expect(img).toHaveAttribute('src', `/api/entries/${image.id}/file`);
    await expect.poll(() => img.evaluate(node => node.naturalWidth)).toBe(1);
  }
  await expect(reader.locator('code a')).toHaveCount(0);
  await reader.getByRole('link', { name: '去复习' }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(target.title);
  await expect(reader.getByRole('heading', { name: '重点' })).toBeInViewport();
  await expect(page).toHaveURL(/\/workspace$/);
  await page.getByRole('button', { name: '上一个笔记', exact: true }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(source.title);
  await reader.getByRole('link', { name: '相对链接' }).click();
  await expect(page.getByRole('textbox', { name: '标题', exact: true })).toHaveValue(target.title);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`attachment image decodes under production CSP (${viewport.width}px)`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const state = defaultState();
    const image = { ...createdNote, id: '99999999999999999999999999999991', kind: 'file', title: 'anon4_probe3.png', content_type: 'image/png', size: 68 };
    state.entries.push(image);
    state.entryById[image.id] = image;
    await mockWorkspace(page, state);
    await page.route('**/api/entries/**/file', route => route.fulfill({ status: 200, contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64') }));
    await page.route('**/workspace', async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': createEdgeoneConfig().headers[0].headers[0].value } });
    });
    await page.goto('/workspace');
    if (viewport.width < 720) await page.getByRole('button', { name: '打开侧栏' }).first().click();
    await page.locator('.obsidian-tree').getByRole('button', { name: image.title }).click();
    const preview = page.locator('.file-preview-pane img');
    await expect(preview).toHaveAttribute('src', /^blob:/);
    await expect.poll(() => preview.evaluate(node => node.naturalWidth)).toBe(1);
  });
}

test('invalid image bytes show an actionable preview error without losing the original', async ({ page }) => {
  const state = defaultState();
  const image = { ...createdNote, id: '99999999999999999999999999999991', kind: 'file', title: '损坏图片.png', content_type: 'image/png', size: 12 };
  state.entries.push(image);
  state.entryById[image.id] = image;
  await mockWorkspace(page, state);
  await page.route('**/api/entries/**/file', route => route.fulfill({ status: 200, contentType: 'image/png', body: 'not PNG bytes' }));
  await page.goto('/workspace');
  await page.locator('.obsidian-tree').getByRole('button', { name: image.title }).click();
  await expect(page.getByRole('alert')).toContainText('图片预览失败');
  await expect(page.locator('.file-preview-pane img')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下载原件' })).toBeEnabled();
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: '下载原件' }).click();
  const download = await downloading;
  expect(await readFile(await download.path(), 'utf8')).toBe('not PNG bytes');
});

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

/** Campus tools are a built-in plugin: 插件 in the sidebar, then its open button. */
async function openCampusTools(page) {
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '插件', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: '打开校园小工具' }).click();
}

/** Binds campus accounts in Settings (校园账号) and closes Settings. */
async function bindCampusAccounts(page, { wpy, office, passphrase = 'long-local-secret-2026' }) {
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
  const settings = page.getByRole('dialog');
  if (await settings.getByRole('button', { name: '更换绑定' }).count()) await settings.getByRole('button', { name: '更换绑定' }).click();
  if (wpy) {
    await settings.getByRole('textbox', { name: /^微北洋账号/ }).fill(wpy[0]);
    await settings.getByLabel('微北洋密码').fill(wpy[1]);
  }
  if (office) {
    await settings.getByRole('textbox', { name: /^办公网账号/ }).fill(office[0]);
    await settings.getByLabel('办公网密码').fill(office[1]);
  }
  await settings.getByLabel('本地解锁口令').fill(passphrase);
  await settings.getByRole('button', { name: '加密保存' }).click();
  await expect(settings.getByText('已加密保存在这台设备上。')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('navigation', { name: '设置分类' })).toHaveCount(0);
}

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
    model: { configured: false, source: 'product', name: 'tju-llm', agent: { sandbox: true, tools: [] }, quota: { limit: 20, used: 0, remaining: 20 } },
    patchError: null,
    reorderError: false,
    sendError: false,
    dropReply: false,
    sentRequests: [],
    holdCreate: null,
    nextFolder: 0,
    nextFile: 0,
    ankiByOwner: {},
    nextCard: 0,
    nextDeck: 0,
    vaultConfigured: false,
    vaultOffline: false,
    vaultObjects: new Map(),
    vaultWrites: [],
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
    if (path === '/api/cli/tokens' && method === 'GET') return json(route, 200, { tokens: state.cliTokens ?? [] });
    if (path === '/api/vault/status') return json(route, 200, { configured: state.vaultConfigured });
    const vaultObject = path.match(/^\/api\/vault\/objects\/([0-9a-f]{32})$/);
    if (vaultObject) {
      if (state.vaultOffline) return json(route, 503, { error: { id: 'vault_unavailable' } });
      const id = vaultObject[1];
      if (method === 'GET') {
        if (!state.vaultObjects.has(id)) return json(route, 404, { error: { id: 'vault_object_not_found' } });
        return route.fulfill({ status: 200, contentType: 'application/vnd.tjuclaw.sealed+json',
          headers: { ETag: '"0123456789abcdef0123456789abcdef01234567"' },
          body: JSON.stringify(state.vaultObjects.get(id)) });
      }
      if (method === 'PUT') {
        if (route.request().headers()['if-none-match'] !== '*') return json(route, 428, { error: { id: 'vault_revision_required' } });
        if (state.vaultObjects.has(id)) return json(route, 409, { error: { id: 'vault_revision_conflict' } });
        state.vaultWrites.push(route.request().postData());
        state.vaultObjects.set(id, route.request().postDataJSON());
        return route.fulfill({ status: 201, contentType: 'application/json',
          headers: { ETag: '"0123456789abcdef0123456789abcdef01234567"' }, body: '{"ok":true}' });
      }
    }
    const ankiOwner = state.session.id;
    const ankiState = state.ankiByOwner[ankiOwner] ??= { decks: [], cards: [] };
    if (path === '/api/reviews' && method === 'GET') return json(route, 200, { reviews: ankiState.reviews ?? [] });
    const studySummary = path.match(/^\/api\/decks\/([^/]+)\/study-summary$/);
    if (studySummary && method === 'GET') {
      const cardIds = new Set(ankiState.cards.filter(card => card.deck_id === studySummary[1]).map(card => card.id));
      const latest = (ankiState.reviews ?? []).filter(review => cardIds.has(review.card_id))
        .map(review => review.reviewed_at).sort().at(-1) ?? null;
      return json(route, 200, { last_reviewed_at: latest });
    }
    if (path === '/api/decks' && method === 'GET') return json(route, 200, { decks: ankiState.decks });
    if (path === '/api/decks' && method === 'POST') {
      const deck = { id: (++state.nextDeck).toString(16).padStart(32, '0'), name: route.request().postDataJSON().name,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
      ankiState.decks.push(deck);
      return json(route, 201, { deck });
    }
    const deckItem = path.match(/^\/api\/decks\/([0-9a-f]{32})$/);
    if (deckItem && method === 'PATCH') {
      const deck = ankiState.decks.find(item => item.id === deckItem[1]);
      if (!deck) return json(route, 404, { error: { id: 'deck_not_found' } });
      Object.assign(deck, route.request().postDataJSON());
      return json(route, 200, { deck });
    }
    if (deckItem && method === 'DELETE') {
      if (!ankiState.decks.some(item => item.id === deckItem[1])) return json(route, 404, { error: { id: 'deck_not_found' } });
      ankiState.decks = ankiState.decks.filter(item => item.id !== deckItem[1]);
      ankiState.cards = ankiState.cards.filter(card => card.deck_id !== deckItem[1]);
      return json(route, 200, { ok: true });
    }
    if (path === '/api/cards' && method === 'GET') {
      return json(route, 200, { cards: ankiState.cards.filter(card => card.deck_id === url.searchParams.get('deck_id')) });
    }
    if (path === '/api/cards' && method === 'POST') {
      const input = route.request().postDataJSON();
      const card = { id: (++state.nextCard).toString(16).padStart(32, '0'), ...input,
        due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 0, lapses: 0,
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
      ankiState.cards.push(card);
      return json(route, 201, { card });
    }
    const ankiCard = path.match(/^\/api\/cards\/([0-9a-f]{32})$/);
    if (ankiCard && method === 'PATCH') {
      const card = ankiState.cards.find(item => item.id === ankiCard[1]);
      if (!card) return json(route, 404, { error: { id: 'card_not_found' } });
      Object.assign(card, route.request().postDataJSON());
      return json(route, 200, { card });
    }
    if (ankiCard && method === 'DELETE') {
      ankiState.cards = ankiState.cards.filter(item => item.id !== ankiCard[1]);
      return json(route, 200, { ok: true });
    }
    if (/^\/api\/decks\/[0-9a-f]{32}\/export$/.test(path) && method === 'GET') {
      const deckId = path.split('/')[3];
      return route.fulfill({
        status: 200, contentType: 'text/tab-separated-values;charset=utf-8',
        body: ankiState.cards.filter(card => card.deck_id === deckId)
          .map(card => `${card.front}\t${card.back}\t${(card.tags ?? []).join(' ')}`).join('\n'),
      });
    }
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
      return json(route, 200, { entries: state.libraries[0]?.id === id ? state.entries.map(entry => ({ ...entry, body: undefined })) : [] });
    }
    if (libEntries && method === 'POST') {
      if (state.holdCreate) await state.holdCreate;
      if (state.session.id !== syntheticSessionA.id) return json(route, 401, { error: { id: 'session_required' } });
      const posted = route.request().postDataJSON() || {};
      // The first new note keeps the fixture id other tests expect; later ones get their own.
      const id = state.entries.some(item => item.id === createdNote.id) ? (++state.nextFolder + 0xc000).toString(16).padStart(32, 'c') : createdNote.id;
      const entry = { ...createdNote, id, parent_id: posted.parent_id || '', kind: posted.kind || 'note', title: posted.title || createdNote.title, ...(posted.body === undefined ? {} : { body: posted.body }) };
      state.entries = [...state.entries, entry];
      state.entryById[entry.id] = entry;
      return json(route, 201, { entry });
    }
    if (/^\/api\/libraries\/[0-9a-f]{32}\/folders$/.test(path) && method === 'POST') {
      const posted = route.request().postDataJSON();
      const id = (++state.nextFolder).toString(16).padStart(32, '0');
      const folder = { ...createdNote, id, kind: 'folder', title: posted.title, parent_id: posted.parent_id || '' };
      state.entries = [...state.entries, folder];
      state.entryById[id] = folder;
      return json(route, 201, { folder });
    }
    if (/^\/api\/libraries\/[0-9a-f]{32}\/entries\/order$/.test(path) && method === 'PUT') {
      if (state.reorderError) return json(route, 503, { error: { id: 'library_storage_unavailable' } });
      const { parent_id, ids } = route.request().postDataJSON();
      if (!ids?.length || ids.some(id => !state.entries.some(entry => entry.id === id && entry.parent_id === parent_id))) {
        return json(route, 400, { error: { id: 'invalid_entry' } });
      }
      state.entries = state.entries.map(entry => ids.includes(entry.id) ? { ...entry, sort_order: ids.indexOf(entry.id) + 1 } : entry);
      return json(route, 200, { ok: true });
    }
    if (/^\/api\/libraries\/[0-9a-f]{32}\/files$/.test(path) && method === 'POST') {
      const multipart = route.request().postDataBuffer()?.toString() ?? '';
      const title = /filename="([^"]+)"/.exec(multipart)?.[1] ?? '未命名文件';
      const contentType = /Content-Type: ([^\r\n]+)/i.exec(multipart)?.[1] ?? 'application/octet-stream';
      const parentId = /name="parent_id"\r\n\r\n([0-9a-f]{32})/.exec(multipart)?.[1] ?? '';
      const entry = { ...createdNote, id: (++state.nextFile).toString(16).padStart(32, '9'), parent_id: parentId, kind: 'file', title, content_type: contentType, size: 5 };
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
    const move = path.match(/^\/api\/entries\/([0-9a-f]{32})\/move$/);
    if (move && method === 'POST') {
      const existing = state.entryById[move[1]];
      const posted = route.request().postDataJSON();
      if (posted.expected_updated_at !== existing.updated_at) return json(route, 409, { error: { id: 'entry_conflict' } });
      const next = { ...existing, parent_id: posted.parent_id, updated_at: '2026-01-01T00:00:04.000Z' };
      state.entryById[move[1]] = next;
      state.entries = state.entries.map(item => item.id === next.id ? next : item);
      return json(route, 200, { entry: next });
    }
    const folderPath = path.match(/^\/api\/folders\/([0-9a-f]{32})$/);
    if (folderPath && method === 'PATCH') {
      const next = { ...state.entryById[folderPath[1]], ...route.request().postDataJSON() };
      state.entryById[next.id] = next;
      state.entries = state.entries.map(item => item.id === next.id ? next : item);
      return json(route, 200, { folder: next });
    }
    if (folderPath && method === 'DELETE') {
      const deleted = new Set([folderPath[1]]);
      let previousSize;
      do {
        previousSize = deleted.size;
        for (const item of state.entries) if (deleted.has(item.parent_id)) deleted.add(item.id);
      } while (deleted.size !== previousSize);
      state.entries = state.entries.filter(item => !deleted.has(item.id));
      for (const id of deleted) delete state.entryById[id];
      return json(route, 200, { ok: true, strategy: 'cascade' });
    }
    const sessions = path.match(/^\/api\/entries\/([0-9a-f]{32})\/sessions$/);
    if (sessions && method === 'GET') return json(route, 200, {
      // As the server lists them: no messages, and a title unless the state asks for an older server.
      sessions: (state.sessionsByEntry[sessions[1]] ?? []).map(listed => {
        const session = state.sessionById[listed.id] ?? listed;
        const question = session.messages?.find(message => message.role === 'user')?.content.trim().replace(/\s+/g, ' ').slice(0, 40);
        const title = session.name || question;
        return { id: session.id, entry_id: session.entry_id, created_at: session.created_at, updated_at: session.updated_at,
          ...(session.name ? { name: session.name } : {}), ...(title && !state.listWithoutTitles ? { title } : {}),
          ...Object.fromEntries(['host', 'project_id', 'folder_id'].filter(key => session[key]).map(key => [key, session[key]])) };
      }),
    });
    if (sessions && method === 'POST') {
      const sess = state.sessionsByEntry[sessions[1]]?.[0] ?? sessionA;
      return json(route, 201, { session: state.sessionById[sess.id] ?? sess });
    }
    const oneSession = path.match(/^\/api\/sessions\/([0-9a-f]{32})$/);
    if (oneSession && method === 'PATCH') {
      const body = route.request().postDataJSON();
      const found = state.sessionById[oneSession[1]];
      if (!found) return json(route, 404, { error: { id: 'session_not_found' } });
      // Placing, as the server does: a project brings its host and leaves any folder; a folder leaves the project.
      if ('host' in body || 'project_id' in body || 'folder_id' in body) {
        const place = { host: found.host ?? '', project_id: found.project_id ?? '', folder_id: found.folder_id ?? '' };
        if ('host' in body) { if (body.host !== place.host) place.project_id = ''; place.host = body.host; }
        if (body.project_id) { place.project_id = body.project_id; place.host = (state.workLayout?.projects ?? []).find(project => project.id === body.project_id)?.host ?? place.host; place.folder_id = ''; }
        else if ('project_id' in body) place.project_id = '';
        if (body.folder_id) { place.folder_id = body.folder_id; place.project_id = ''; } else if ('folder_id' in body) place.folder_id = '';
        state.sessionById[oneSession[1]] = { ...state.sessionById[oneSession[1]], ...place };
        state.placements = [...(state.placements ?? []), { id: found.id, ...place }];
        return json(route, 200, { id: found.id, ...place });
      }
      const name = String(body.title ?? '').trim().replace(/\s+/g, ' ');
      state.sessionById[oneSession[1]] = { ...found, name: name || undefined };
      return json(route, 200, { id: found.id, name });
    }
    if (oneSession && method === 'DELETE') {
      if (!state.sessionById[oneSession[1]]) return json(route, 404, { error: { id: 'session_not_found' } });
      delete state.sessionById[oneSession[1]];
      for (const entry of Object.keys(state.sessionsByEntry)) state.sessionsByEntry[entry] = state.sessionsByEntry[entry].filter(session => session.id !== oneSession[1]);
      return route.fulfill({ status: 204 });
    }
    if (oneSession && method === 'GET') {
      const found = state.sessionById[oneSession[1]] ?? sessionA;
      return json(route, 200, { session: found });
    }
    const message = path.match(/^\/api\/sessions\/([0-9a-f]{32})\/messages$/);
    if (message && method === 'POST') {
      const posted = route.request().postDataJSON();
      state.sentRequests.push(posted);
      if (state.sendError) return json(route, 503, { error: { id: 'agent_unavailable' } });
      const { content, client_request_id } = posted;
      const previous = state.sessionById[message[1]] ?? sessionA;
      const existing = previous.messages?.find(item => item.client_request_id === client_request_id);
      const next = existing ? previous : { ...previous, messages: [
        ...(previous.messages ?? []),
        { role: 'user', content, client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
        { role: 'assistant', content: '**已收到**你的问题。', created_at: '2026-01-01T00:00:11.000Z' },
      ] };
      state.sessionById[message[1]] = next;
      if (state.dropReply) { state.dropReply = false; return route.abort('failed'); }
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
  for (const theme of ['light', 'dark']) {
    for (const mobile of [false, true]) {
      test(`matches loading and document backgrounds in ${theme} mode on ${mobile ? 'mobile' : 'desktop'}`, async ({ page }) => {
        if (mobile) await page.setViewportSize({ width: 390, height: 844 });
        // A saved choice must win even when the device prefers the opposite theme.
        await page.emulateMedia({ colorScheme: theme === 'light' ? 'dark' : 'light' });
        await page.addInitScript(mode => {
          localStorage.setItem('tjuclaw.appearance.v1', JSON.stringify({ mode, accent: 'mono' }));
        }, theme);
        await mockWorkspace(page, defaultState());
        let releaseChunk;
        const chunkReady = new Promise(resolve => { releaseChunk = resolve; });
        await page.route(/\/assets\/workspace.*\.js/, async route => {
          await chunkReady;
          await route.continue();
        });
        let releaseSession;
        const sessionReady = new Promise(resolve => { releaseSession = resolve; });
        await page.route('**/api/auth/session', async route => {
          await sessionReady;
          await route.fallback();
        });
        await page.clock.install();
        await page.clock.pauseAt(new Date());
        await page.goto('/workspace');
        const opening = page.locator('.workspace-opening');
        await expect(opening).toHaveCSS('opacity', '1');
        const card = page.locator('.workspace-opening-card');
        await expect(card).toHaveCSS('opacity', '0');
        await page.clock.runFor(239);
        await expect(card).toHaveCSS('opacity', '0');
        await page.clock.runFor(1);
        await expect(card).toHaveCSS('opacity', '1');
        await page.clock.resume();
        await page.screenshot({ path: `../test-results/workspace/loading-document-${theme}-${mobile ? 'mobile' : 'desktop'}.png` });
        const appBackground = await opening.evaluate(el => getComputedStyle(el).backgroundColor);
        releaseChunk();
        await expect(page.getByRole('progressbar', { name: '加载进度' })).toHaveAttribute('aria-valuetext', '阶段 2/6：验证登录状态');
        const dataBackground = await opening.evaluate(el => getComputedStyle(el).backgroundColor);
        const decoration = await opening.evaluate(el => ({
          image: getComputedStyle(el).backgroundImage,
          texture: getComputedStyle(el, '::before').display,
          drawings: el.querySelectorAll('.bp-backdrop').length,
        }));
        releaseSession();
        await expect(page.locator('.obsidian-main')).toBeVisible();
        const documentBackground = await page.locator('.obsidian-main').evaluate(el => getComputedStyle(el).backgroundColor);
        expect(appBackground).toBe(documentBackground);
        expect(dataBackground).toBe(documentBackground);
        expect(decoration).toEqual({ image: 'none', texture: 'none', drawings: 0 });
      });
    }
  }

  test('keeps Markdown and Tiptap documents separate across saves and reloads', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '新建富文本文档', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '富文本正文' })).toBeVisible();
    await page.getByRole('textbox', { name: '富文本正文' }).fill('课程重点');
    await page.getByRole('textbox', { name: '富文本正文' }).press('ControlOrMeta+a');
    await page.getByRole('button', { name: '加粗', exact: true }).click();
    await expect.poll(() => state.entryById[createdNote.id]?.body).toContain('课程重点');
    expect(JSON.parse(state.entryById[createdNote.id].body).type).toBe('doc');
    expect(JSON.parse(state.entryById[createdNote.id].body).content[0].content[0].marks).toEqual([{ type: 'bold' }]);
    expect(state.entryById[noteA.id].body).toBe('Private note body');
    await page.reload();
    await page.locator('.obsidian-tree').getByRole('button', { name: '未命名文档', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '富文本正文' })).toContainText('课程重点');
    await expect(page.getByRole('textbox', { name: '富文本正文' }).locator('strong')).toContainText('课程重点');
    await page.locator('.obsidian-tree').getByRole('button', { name: 'First note for user A', exact: true }).click();
    await expect(page.locator('.codemirror-editor')).toContainText('Private note body');
  });

  test('saves an edit to the note restored from this device after a reload', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await expect(editor).toContainText('Private note body');
    await page.reload();
    // The restored note paints from this device's copy; editing it at once must still save.
    await expect(editor).toContainText('Private note body');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Edited right after reload');
    await expect.poll(() => state.entryById[noteA.id].body).toBe('Edited right after reload');
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
    await expect(page.locator('.workspace-error')).toHaveCount(0);
  });

  test('uploads an Office original without claiming an unsupported preview', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByLabel('上传课程资料').setInputFiles({ name: '课程大纲.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from('draft') });
    await expect(page.getByRole('textbox', { name: '文件名' })).toHaveValue('课程大纲.docx');
    await expect(page.locator('.file-preview-placeholder')).toContainText('此格式暂不支持在线预览');
    await expect(page.locator('.obsidian-tree').getByRole('button', { name: '课程大纲.docx' })).toBeVisible();
  });

  test('previews approved images and rejects a mislabeled PDF', async ({ page }) => {
    const state = defaultState();
    const image = { ...createdNote, id: '99999999999999999999999999999991', kind: 'file', title: '课程图.gif', content_type: 'image/gif', size: 34 };
    const pdf = { ...image, id: '99999999999999999999999999999992', title: '课程资料.pdf', content_type: 'application/pdf' };
    state.entries.push(image, pdf);
    state.entryById[image.id] = image;
    state.entryById[pdf.id] = pdf;
    await mockWorkspace(page, state);
    await page.route('**/api/entries/**/file', route => route.request().url().includes(image.id)
      ? route.fulfill({ status: 200, contentType: 'image/gif', body: Buffer.from('R0lGODlhAQABAAAAACwAAAAAAQABAAA=', 'base64') })
      : route.fulfill({ status: 200, contentType: 'application/pdf', body: '<html>not a PDF</html>' }));
    await page.goto('/workspace');
    await page.locator('.obsidian-tree').getByRole('button', { name: image.title }).click();
    await expect(page.locator('.file-preview-pane img')).toBeVisible();
    await page.locator('.obsidian-tree').getByRole('button', { name: pdf.title }).click();
    await expect(page.getByRole('alert')).toContainText('预览暂不可用');
    await expect(page.locator('.file-preview-pane iframe')).toHaveCount(0);
  });

  test('requires a workspace passphrase before opening workspace data', async ({ page }) => {
    await mockWorkspace(page, defaultState(), { seedWorkspaceUnlock: false });
    await page.goto('/workspace');
    await expect(page.getByRole('heading', { name: '创建工作区口令' })).toBeVisible();
    await expect(page.getByText(/口令用于在这台设备上解锁工作区/)).toBeVisible();
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
    // The device that created the passphrase stays unlocked across browser sessions.
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toHaveCount(0);
    // What is kept is not the passphrase, and without it the gate is back.
    const kept = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('tjuclaw.workspace.remembered.v1.')).map(key => [key, localStorage.getItem(key)]));
    expect(kept).toHaveLength(1);
    expect(kept[0][1]).not.toContain('workspace-secret-2026');
    expect(Object.keys(JSON.parse(kept[0][1])).sort()).toEqual(['binding', 'until']);
    await page.evaluate(key => { sessionStorage.clear(); localStorage.removeItem(key); }, kept[0][0]);
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await expect(page.getByRole('checkbox', { name: '在这台设备上保持解锁 30 天' })).toBeChecked();
    await page.getByLabel('工作区口令').fill('wrong-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('alert')).toHaveText('口令错误，或此设备上的验证材料已损坏。');
  });

  test('remote workspace verifier unlocks without local records and fails closed while offline', async ({ page }) => {
    const state = defaultState();
    state.vaultConfigured = true;
    await mockWorkspace(page, state, { seedWorkspaceUnlock: false });
    await page.goto('/workspace');
    await expect(page.getByRole('heading', { name: '创建工作区口令' })).toBeVisible();
    await expect(page.getByText(/口令可在你的其他设备上解锁此工作区/)).toBeVisible();
    await page.getByRole('textbox', { name: '创建工作区口令' }).fill('remote-workspace-secret');
    await page.getByLabel('再次输入口令').fill('remote-workspace-secret');
    await page.getByRole('checkbox').check();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '创建并下载备份' }).click();
    await downloadPromise;
    await page.getByRole('button', { name: '我已安全备份，进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    expect(state.vaultWrites).toHaveLength(1);
    expect(state.vaultWrites[0]).not.toContain('remote-workspace-secret');
    expect(await page.evaluate(id => localStorage.getItem(`tjuclaw.workspace.vault.v1.user-identity-uuid-aaaa.${id}`), libA.id)).toBeNull();
    // This device stays unlocked after a reload, without the passphrase being kept anywhere.
    await page.reload();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain('remote-workspace-secret');
    // Another device, or this one once it forgets, is asked for the passphrase.
    const rememberedKey = `tjuclaw.workspace.remembered.v1.user-identity-uuid-aaaa.${libA.id}`;
    await page.evaluate(key => localStorage.removeItem(key), rememberedKey);
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('wrong-remote-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('alert')).toContainText('口令不正确');
    // Unlocking without keeping the device unlocked lasts for this page only.
    await page.getByRole('checkbox', { name: '在这台设备上保持解锁 30 天' }).uncheck();
    await page.getByLabel('工作区口令').fill('remote-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    expect(await page.evaluate(key => localStorage.getItem(key), rememberedKey)).toBeNull();
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('remote-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    // A passphrase changed on another device gives the verifier a new revision: this device asks again.
    await page.evaluate(key => localStorage.setItem(key, JSON.stringify({ binding: '"' + '0'.repeat(40) + '"', until: Date.now() + 1e9 })), rememberedKey);
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('remote-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    // A kept unlock that has run out asks again too.
    await page.evaluate(key => { const kept = JSON.parse(localStorage.getItem(key)); localStorage.setItem(key, JSON.stringify({ ...kept, until: Date.now() - 1000 })); }, rememberedKey);
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('remote-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
    // Kept unlocked or not, the workspace does not open while the verifier cannot be read.
    state.vaultOffline = true;
    await page.reload();
    await expect(page.getByText('工作区暂时无法连接，请稍后重试。')).toBeVisible();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toHaveCount(0);
  });

  test('vault status outage never selects a local verifier or loads private notes', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const privateReads = [];
    page.on('request', request => {
      if (/\/api\/(libraries\/[0-9a-f]{32}\/entries|entries\/[0-9a-f]{32})$/.test(new URL(request.url()).pathname)) {
        privateReads.push(request.url());
      }
    });
    await page.route('**/api/vault/status', route => json(route, 503, { error: { id: 'vault_unavailable' } }));
    await page.goto('/workspace');
    await expect(page.getByText('工作区暂时无法连接，请稍后重试。')).toBeVisible();
    await expect(page.getByRole('heading', { name: '创建工作区口令' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toHaveCount(0);
    expect(privateReads).toEqual([]);
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
    await openCampusTools(page);
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
    await openCampusTools(page);
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
    await openCampusTools(page);
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    await expect(page.getByText('入校码需要实时认证')).toBeVisible();
    await bindCampusAccounts(page, { wpy: ['campus-secret-user', 'campus-secret-password'], office: ['office-secret-user', 'office-secret-password'], passphrase: 'long-local-secret-2026' });
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    await expect(page.getByRole('region', { name: '校园账号' })).toHaveCount(0);
    const storage = await page.evaluate(() => localStorage.getItem('tjuclaw.campus.credentials.v1.user-identity-uuid-aaaa'));
    expect(storage).toBeTruthy();
    expect(storage).not.toContain('campus-secret-user');
    expect(storage).not.toContain('campus-secret-password');
    await page.reload();
    await openCampusTools(page);
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    // A locked binding points to Settings, where it is unlocked.
    await page.getByRole('region', { name: '校园账号' }).getByRole('button', { name: '去解锁' }).click();
    const settings = page.getByRole('dialog');
    await settings.getByLabel('本地解锁口令').fill('wrong-password');
    await settings.getByRole('button', { name: '解锁' }).click();
    await expect(settings.getByText('解锁失败：口令错误或本地数据已损坏。')).toBeVisible();
    await settings.getByLabel('本地解锁口令').fill('long-local-secret-2026');
    await settings.getByRole('button', { name: '解锁' }).click();
    await expect(settings.getByText('账号 campus-secret-user')).toBeVisible();
    await expect(settings.getByText('账号 office-secret-user')).toBeVisible();
    await page.keyboard.press('Escape');
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [{ ...guideB }];
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await openCampusTools(page);
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
    await expect(page.getByRole('region', { name: '校园账号' }).getByRole('button', { name: '去绑定' })).toBeVisible();
    await expect(page.getByText('campus-secret-user')).toHaveCount(0);
  });

  test('connects office with a visible captcha and loads live academic data without forwarding credentials', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let captchaCount = 0;
    let officeAttempts = 0;
    let academicRequests = 0;
    await page.route('**/api/campus/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/campus/session' && request.method() === 'POST') return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      if (path === '/api/campus/office/captcha') return json(route, 200, { captcha_id: `captcha-${++captchaCount}`, content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      if (path === '/api/campus/office/session' && request.method() === 'POST') {
        officeAttempts++;
        const body = request.postDataJSON();
        expect(body).toMatchObject({ username: 'office-user', password: 'office-password', captcha_id: `captcha-${captchaCount}` });
        return officeAttempts === 1
          ? json(route, 400, { error: { id: 'campus_office_captcha_expired' } })
          : json(route, 200, { username: 'office-user', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path.startsWith('/api/campus/academic/')) {
        academicRequests++;
        expect(request.postData()).toBeNull();
        if (path.endsWith('/classes')) return json(route, 200, { courses: { major: [{ name: '线性代数', arrangeList: [{ weekday: 1, unitList: [1, 2], location: '教一' }] }], minor: [] }, exams: [], gpa: { courses: [{ name: '线性代数', credit: 4, gpa: 3.5 }] } });
        if (path.endsWith('/exams')) return json(route, 200, { exams: [{ id: 'exam-1', name: '线性代数', date: '2026-10-10', location: '教一' }] });
        if (path.endsWith('/gpa')) return json(route, 200, { gpa: { courses: [{ name: '线性代数', credit: 4, gpa: 3.8 }] } });
      }
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    await expect(page.getByRole('img', { name: '办公网验证码' })).toBeVisible();
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect(page.getByRole('alert')).toContainText('验证码已过期');
    expect(academicRequests).toBe(0);
    await page.getByRole('button', { name: '刷新图片' }).click();
    await page.getByRole('textbox', { name: '图片验证码' }).fill('5678');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect(page.getByRole('img', { name: '办公网验证码' })).toHaveCount(0);
    await expect(page.locator('.campus-class').first()).toContainText('线性代数');
    await expect(page.locator('.campus-exam-list')).toContainText('2026-10-10');
    await page.locator('.campus-sidebar-list').getByRole('button', { name: 'GPA', exact: true }).click();
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('3.800');
    expect(captchaCount).toBe(2);
    expect(academicRequests).toBe(3);
  });

  test('reuses the matching server-side office session without requesting a new captcha', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let captchaRequests = 0;
    let officeLogins = 0;
    let academicRequests = 0;
    await page.route('**/api/campus/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/campus/session' && request.method() === 'POST') {
        return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/session' && request.method() === 'GET') {
        return json(route, 200, { username: 'office-user', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/captcha') {
        captchaRequests++;
        return json(route, 500, {});
      }
      if (path === '/api/campus/office/session' && request.method() === 'POST') {
        officeLogins++;
        return json(route, 500, {});
      }
      if (path === '/api/campus/academic/classes') {
        academicRequests++;
        return json(route, 200, { courses: { major: [{ name: '后端课表', arrangeList: [{ weekday: 1, unitList: [1, 2] }] }] }, exams: [], gpa: {} });
      }
      if (path === '/api/campus/academic/exams') return json(route, 200, { exams: [] });
      if (path === '/api/campus/academic/gpa') return json(route, 200, { gpa: {} });
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    await expect(page.locator('.campus-class').first()).toContainText('后端课表');
    await expect(page.getByRole('img', { name: '办公网验证码' })).toHaveCount(0);
    expect(academicRequests).toBeGreaterThan(0);
    expect(captchaRequests).toBe(0);
    expect(officeLogins).toBe(0);
  });

  test('ignores an office login response received after locking the campus account', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let releaseOffice;
    let officeLogins = 0;
    let academicReads = 0;
    const pendingOffice = new Promise(resolve => { releaseOffice = resolve; });
    await page.route('**/api/campus/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/campus/session' && route.request().method() === 'POST') {
        return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/captcha') {
        return json(route, 200, { captcha_id: 'late-office', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/session' && route.request().method() === 'POST') {
        officeLogins++;
        await pendingOffice;
        return json(route, 200, { username: 'office-user', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path.startsWith('/api/campus/academic/')) academicReads++;
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect.poll(() => officeLogins).toBe(1);
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '锁定' }).click();
    await page.keyboard.press('Escape');
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/campus/office/session' && res.request().method() === 'POST');
    releaseOffice();
    await response;
    await expect(page.getByRole('region', { name: '校园账号' }).getByRole('button', { name: '去解锁' })).toBeVisible();
    await expect(page.locator('.campus-class')).toHaveCount(0);
    await page.waitForTimeout(150);
    expect(academicReads).toBe(0);
  });

  test('uses campus semester and weekList when switching the live timetable week', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let startAt = '';
    await page.route('**/api/campus/**', route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/campus/session' && route.request().method() === 'POST') {
        return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/semester') {
        return json(route, 200, { semester: {
          semesterName: '测试学期', semesterStartAt: startAt,
          semesterStartTimestamp: Date.parse(`${startAt}T00:00:00+08:00`) / 1000,
        } });
      }
      if (path === '/api/campus/office/captcha') {
        return json(route, 200, { captcha_id: 'semester-captcha', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/session' && route.request().method() === 'POST') {
        return json(route, 200, { username: 'office-user', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/academic/classes') {
        return json(route, 200, { courses: { major: [
          { name: '第一周课程', arrangeList: [{ weekday: 1, weekList: [1], unitList: [1, 2], location: '教一' }] },
          { name: '第二周课程', arrangeList: [{ weekday: 1, weekList: [2], unitList: [1, 2], location: '教二' }] },
        ] }, exams: [], gpa: {} });
      }
      return json(route, 502, { error: { id: 'campus_academic_unavailable' } });
    });
    await page.goto('/workspace');
    startAt = await page.evaluate(() => {
      const date = new Date();
      date.setDate(date.getDate() - (date.getDay() + 6) % 7);
      return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    });
    await openCampusTools(page);
    await page.getByRole('textbox', { name: '课程名' }).fill('手动课程');
    await page.getByRole('button', { name: '添加到课表' }).click();
    await expect(page.locator('.campus-class')).toContainText('手动课程');
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect(page.locator('.campus-schedule-nav')).toContainText('第 1 教学周');
    await expect(page.getByRole('button', { name: /^第一周课程，/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^手动课程，/ })).toBeVisible();
    await expect(page.getByRole('button', { name: '删除课程 手动课程' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^第二周课程，/ })).toHaveCount(0);
    await page.getByRole('button', { name: '下一周' }).click();
    await expect(page.locator('.campus-schedule-nav')).toContainText('第 2 教学周');
    await expect(page.getByRole('button', { name: /^第二周课程，/ })).toBeVisible();
    await expect(page.getByRole('button', { name: /^第一周课程，/ })).toHaveCount(0);
  });

  test('keeps office authentication open when academic validation fails', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let academicReady = false;
    let academicExpired = false;
    let academicUnavailable = false;
    let disconnects = 0;
    let officeLogins = 0;
    let academicReads = 0;
    await page.route('**/api/campus/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/api/campus/session' && request.method() === 'POST') return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      if (path === '/api/campus/office/captcha') return json(route, 200, { captcha_id: 'captcha-1', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      if (path === '/api/campus/office/session' && request.method() === 'POST') {
        officeLogins++;
        return json(route, 200, { username: 'office-user', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (path === '/api/campus/office/session' && request.method() === 'DELETE') {
        disconnects++;
        return json(route, 204, {});
      }
      if (path === '/api/campus/academic/classes') {
        academicReads++;
        return academicExpired
          ? json(route, 401, { error: { id: 'campus_office_session_expired' } })
          : academicUnavailable
          ? json(route, 502, { error: { id: 'campus_academic_unavailable' } })
          : academicReady
          ? json(route, 200, { courses: { major: [{ name: '线性代数', arrangeList: [{ weekday: 1, unitList: [1, 2], location: '教一' }] }], minor: [] }, exams: [{ name: '线性代数', date: '2026-10-10' }], gpa: { courses: [{ name: '线性代数', credit: 4, gpa: 3.5 }] } })
          : json(route, 502, { error: { id: 'campus_invalid_response' } });
      }
      if (path.startsWith('/api/campus/academic/')) return json(route, 502, { error: { id: 'campus_academic_unavailable' } });
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect(page.getByRole('alert')).toContainText('教务数据暂时无法验证');
    await expect(page.getByRole('img', { name: '办公网验证码' })).toHaveCount(0);
    await expect.poll(() => academicReads).toBe(1);
    expect(disconnects).toBe(0);
    academicReady = true;
    await page.getByRole('button', { name: '刷新教务数据' }).click();
    await expect(page.getByRole('img', { name: '办公网验证码' })).toHaveCount(0);
    await expect(page.locator('.campus-class')).toContainText('线性代数');
    await expect(page.locator('.campus-exam-list')).toContainText('2026-10-10');
    await page.locator('.campus-sidebar-list').getByRole('button', { name: 'GPA', exact: true }).click();
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('3.500');
    await page.getByRole('textbox', { name: '课程名' }).fill('本地成绩');
    await page.getByLabel('学分', { exact: true }).fill('2');
    await page.getByLabel('绩点（0–4）').fill('4');
    await page.getByRole('button', { name: '计入平均' }).click();
    academicUnavailable = true;
    await page.getByRole('button', { name: '刷新教务数据' }).click();
    await expect(page.getByRole('alert')).toContainText('教务数据暂时无法验证');
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('4.000');
    await expect(page.locator('.campus-grade-list')).toContainText('本地成绩');
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '课程表', exact: true }).click();
    await expect(page.locator('.campus-class')).toHaveCount(0);
    await expect(page.locator('.campus-exam-list')).toHaveCount(0);
    academicUnavailable = false;
    await page.getByRole('button', { name: '刷新教务数据' }).click();
    await expect(page.locator('.campus-class')).toContainText('线性代数');
    expect(officeLogins).toBe(1);
    expect(disconnects).toBe(0);
    academicExpired = true;
    await page.getByRole('button', { name: '刷新教务数据' }).click();
    await expect(page.getByRole('img', { name: '办公网验证码' })).toBeVisible();
    await expect(page.locator('.campus-class')).toHaveCount(0);
    await expect(page.locator('.campus-exam-list')).toHaveCount(0);
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: 'GPA', exact: true }).click();
    await expect(page.locator('.campus-gpa-result strong')).toHaveText('4.000');
    await expect(page.getByRole('button', { name: '连接办公网' }).first()).toBeVisible();
    expect(officeLogins).toBe(1);
  });

  test('reads paginated forum posts and clears them when campus account is locked', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    const requestedPages = [];
    let invalidRefresh = false;
    await page.route('**/api/campus/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/campus/session' && request.method() === 'POST') {
        return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.pathname === '/api/campus/office/captcha') {
        return json(route, 200, { captcha_id: 'captcha-forum', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      }
      if (url.pathname === '/api/campus/forum/posts') {
        const current = Number(url.searchParams.get('page'));
        requestedPages.push(current);
        if (invalidRefresh) return json(route, 200, { data: { list: 'invalid' } });
        const list = current === 1 ? Array.from({ length: 10 }, (_, index) => ({
          id: index + 1, title: `校园帖子 ${index + 1}`, created_at: '2026-09-26T10:00:00Z',
          comment_count: index, like_count: index + 2, tag: { name: '学习' },
        })) : [{ id: 11, title: '最后一帖', created_at: '2026-09-26T11:00:00Z' }];
        return json(route, 200, { data: { list, total: 11 } });
      }
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '论坛' }).click();
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    await page.getByRole('button', { name: '读取帖子' }).click();
    await expect(page.locator('.campus-forum-list li')).toHaveCount(10);
    await expect(page.locator('.campus-forum-list')).toContainText('回复 0');
    await page.getByRole('button', { name: '下一页' }).click();
    await expect(page.locator('.campus-forum-list li')).toHaveCount(1);
    await expect(page.locator('.campus-forum-list')).toContainText('最后一帖');
    expect(requestedPages).toEqual([1, 2]);
    invalidRefresh = true;
    await page.getByRole('button', { name: '刷新帖子' }).click();
    await expect(page.getByRole('alert')).toContainText('论坛数据格式异常');
    await expect(page.locator('.campus-forum-list')).toContainText('最后一帖');
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
    await page.getByRole('dialog').getByRole('button', { name: '锁定' }).click();
    await page.keyboard.press('Escape');
    await expect(page.locator('.campus-forum-list li')).toHaveCount(0);
    await expect(page.getByRole('region', { name: '校园账号' }).getByRole('button', { name: '去解锁' })).toBeVisible();
  });

  test('checks studyroom availability by date and session and renders schedule states', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    const queries = [];
    await page.route('**/api/campus/**', route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.pathname === '/api/campus/session' && request.method() === 'POST') return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
      if (url.pathname === '/api/campus/office/captcha') return json(route, 200, { captcha_id: 'captcha-room', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' });
      if (url.pathname === '/api/campus/studyroom/campuses') return json(route, 200, { data: [{ id: 1, name: '北洋园校区' }] });
      if (url.pathname === '/api/campus/studyroom/campuses/1/buildings') return json(route, 200, { data: [{ id: 4, name: '一教' }] });
      if (url.pathname === '/api/campus/studyroom/buildings/4/rooms') {
        queries.push(Object.fromEntries(url.searchParams));
        return json(route, 200, { data: [{ id: 363, name: '44楼A区103', free: url.searchParams.get('session') === '2' }, { id: 68, name: '44楼A区104' }] });
      }
      if (url.pathname === '/api/campus/studyroom/rooms/363/schedule') return json(route, 200, { data: [{ id: 1, name: '高等数学', date: '2026-10-08', session: 1, free: false }] });
      if (url.pathname === '/api/campus/studyroom/rooms/68/schedule') return json(route, 200, { data: [] });
      return json(route, 204, {});
    });
    await page.goto('/workspace');
    await openCampusTools(page);
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '空教室' }).click();
    await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'], office: ['office-user', 'office-password'], passphrase: 'long-local-secret-2026' });
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
    await page.getByRole('button', { name: '读取校区' }).click();
    await page.getByRole('button', { name: '北洋园校区' }).click();
    await page.getByLabel('日期').fill('2026-10-08');
    await page.getByRole('button', { name: '一教', exact: true }).click();
    await expect(page.getByRole('button', { name: '44楼A区103 使用中' })).toBeVisible();
    await page.getByLabel('节次').selectOption('2');
    await expect(page.getByRole('button', { name: '44楼A区103 空闲' })).toBeVisible();
    expect(queries.at(-1)).toEqual({ session: '2', date: '2026-10-08' });
    await page.getByLabel('日期').fill('');
    await expect(page.locator('.campus-service-sheet').getByRole('status')).toContainText('请选择日期后查询教室');
    await expect(page.getByRole('button', { name: '44楼A区103 空闲' })).toHaveCount(0);
    await page.getByLabel('日期').fill('2026-10-08');
    await expect(page.getByRole('button', { name: '44楼A区103 空闲' })).toBeVisible();
    await page.getByRole('button', { name: '44楼A区103 空闲' }).click();
    await expect(page.getByRole('region', { name: '教室时间表' })).toContainText('高等数学');
    await expect(page.getByRole('region', { name: '教室时间表' })).toContainText('第 1 节');
    await page.getByRole('button', { name: '44楼A区104 状态未知' }).click();
    await expect(page.getByRole('region', { name: '教室时间表' })).toContainText('暂无时间表记录');
    await expect(page.locator('.campus-live-json')).toHaveCount(0);
  });

  test('mobile tools float over the content and focus timer resumes on return', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await openCampusTools(page);
    // The tools are listed in the drawer, which opening a plugin closed.
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect(page.locator('.campus-sidebar-list')).toBeVisible();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '番茄时钟' }).click();
    await expect(page.locator('.campus-focus-clock')).toBeVisible();
    await page.getByRole('button', { name: '开始专注' }).click();
    await expect(page.getByRole('button', { name: '暂停' })).toBeVisible();
    await page.reload();
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await openCampusTools(page);
    await page.getByRole('button', { name: '打开侧栏' }).click();
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
    const secondNote = { ...noteC, created_at: '2026-01-01T00:00:02.000Z' };
    state.entries.push(secondNote);
    state.entryById[noteC.id] = secondNote;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const tree = page.locator('.obsidian-tree');
    const noteNames = () => tree.locator('.obsidian-tree-row:not(.campus-note-row) .tree-item span').allTextContents();
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
    await expect.poll(() => tree.locator('.obsidian-tree-row:not(.campus-note-row) .tree-item span').allTextContents()).toEqual(['Second note for user A', 'First note for user A']);
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('资料');
    await page.locator('.tree-inline-input').press('Enter');
    const folder = tree.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) });
    await first.dragTo(folder, { targetPosition: { x: 50, y: 16 } });
    await expect(folder.locator('.tree-item span')).toHaveText('资料');
    await expect(tree.locator('.tree-children').getByRole('button', { name: 'First note for user A' })).toBeVisible();
  });

  test('warns before cascading a folder deletion and clears deleted documents from the active workspace', async ({ page }) => {
    const state = defaultState();
    const folder = { ...createdNote, id: '99999999999999999999999999999999', kind: 'folder', title: '资料' };
    const nested = { ...folder, id: '88888888888888888888888888888888', title: '子目录', parent_id: folder.id };
    const inside = { ...noteA, parent_id: nested.id };
    state.entries = [guideA, folder, nested, inside, noteC];
    state.entryById = Object.fromEntries(state.entries.map(item => [item.id, item]));
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await expect(page.locator('.note-title')).toHaveValue(inside.title);
    const deleteFolder = async () => {
      await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) })
        .getByRole('button', { name: '文件夹操作' }).click();
      await page.getByRole('menuitem', { name: '删除' }).click();
    };
    page.once('dialog', async dialog => {
      expect(dialog.message()).toContain('永久删除');
      expect(dialog.message()).not.toContain('移回根目录');
      await dialog.dismiss();
    });
    await deleteFolder();
    await expect(page.getByRole('button', { name: '资料', exact: true })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await deleteFolder();
    await expect(page.getByRole('button', { name: '资料', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: inside.title, exact: true })).toHaveCount(0);
    await expect(page.locator('.note-title')).toHaveCount(0);
    await expect(page.getByRole('button', { name: noteC.title, exact: true })).toBeVisible();
    expect(state.entries.map(item => item.id)).toEqual([guideA.id, noteC.id]);
    await page.reload();
    await expect(page.getByRole('button', { name: noteC.title, exact: true })).toBeVisible();
  });

  test('saves pending note edits before moving and uses the moved revision for later edits', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const patches = [];
    await page.route(`**/api/entries/${noteA.id}`, route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      const patch = route.request().postDataJSON();
      patches.push(patch);
      const current = state.entryById[noteA.id];
      if (patch.expected_updated_at !== current.updated_at) {
        return json(route, 409, { error: { id: 'entry_conflict' } });
      }
      const next = { ...current, ...patch, updated_at: patches.length === 1
        ? '2026-01-01T00:00:03.000Z' : '2026-01-01T00:00:05.000Z' };
      state.entryById[noteA.id] = next;
      state.entries = state.entries.map(item => item.id === noteA.id ? next : item);
      return json(route, 200, { entry: next });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('资料');
    await page.locator('.tree-inline-input').press('Enter');
    const editor = page.locator('.codemirror-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Before move');
    await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: noteA.title, exact: true }) })
      .getByRole('button', { name: '文档操作' }).click();
    await page.getByRole('menuitem', { name: '移动到…' }).click();
    await page.getByRole('dialog', { name: '移动到' }).getByRole('button', { name: /资料/ }).click();
    await expect.poll(() => state.entryById[noteA.id].parent_id).not.toBe('');
    expect(patches[0]).toMatchObject({ body: 'Before move', expected_updated_at: noteA.updated_at });
    expect(state.entryById[noteA.id].body).toBe('Before move');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('After move');
    await expect.poll(() => patches.length).toBe(2);
    expect(patches[1]).toMatchObject({ body: 'After move', expected_updated_at: '2026-01-01T00:00:04.000Z' });
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
  });

  test('creates a note inside a folder from the folder actions on phones', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await page.getByRole('button', { name: '新建文件夹' }).click();
    await page.locator('.tree-inline-input').fill('资料');
    await page.locator('.tree-inline-input').press('Enter');
    await page.locator('.obsidian-tree-row').filter({ has: page.getByRole('button', { name: '资料', exact: true }) }).getByRole('button', { name: '文件夹操作' }).click();
    await page.getByRole('menuitem', { name: '新建笔记' }).click();
    await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect(page.locator('.obsidian-tree .tree-children').getByRole('button', { name: '未命名笔记' })).toBeVisible();
  });

  test('reorders flashcards without changing their data', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
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

  test('uses server ordering instead of stale local note order and rolls back failed reorders', async ({ page }) => {
    const state = defaultState();
    state.entries.push({ ...noteC, sort_order: 1 });
    state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, sort_order: 2 } : entry);
    state.entryById[noteC.id] = noteC;
    await mockWorkspace(page, state);
    await page.addInitScript(({ identity, ids }) => {
      localStorage.setItem(`tjuclaw.sidebar.order.v1.${identity}`, JSON.stringify({ 'notes:root': ids }));
    }, { identity: syntheticSessionA.id, ids: [`entry:${noteA.id}`, `entry:${noteC.id}`] });
    await page.goto('/workspace');
    const noteNames = page.locator('.obsidian-tree > .obsidian-tree-node > .obsidian-tree-row .tree-item span');
    await expect.poll(() => noteNames.allTextContents()).toEqual(['Second note for user A', 'First note for user A']);
    const first = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: 'Second note for user A', exact: true }) }).locator(':scope > .obsidian-tree-row');
    const second = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: 'First note for user A', exact: true }) }).locator(':scope > .obsidian-tree-row');
    await second.dragTo(first, { targetPosition: { x: 20, y: 2 } });
    await expect.poll(() => noteNames.allTextContents()).toEqual(['First note for user A', 'Second note for user A']);
    await expect.poll(() => state.entries.find(entry => entry.id === noteA.id)?.sort_order).toBe(1);
    await page.reload();
    await expect.poll(() => noteNames.allTextContents()).toEqual(['First note for user A', 'Second note for user A']);
    state.reorderError = true;
    const moved = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: 'Second note for user A', exact: true }) }).locator(':scope > .obsidian-tree-row');
    const target = page.locator('.obsidian-tree > .obsidian-tree-node').filter({ has: page.getByRole('button', { name: 'First note for user A', exact: true }) }).locator(':scope > .obsidian-tree-row');
    await moved.dragTo(target, { targetPosition: { x: 20, y: 2 } });
    await expect(page.getByText('保存手动排序失败，已恢复原顺序，请稍后再试。')).toBeVisible();
    await expect.poll(() => noteNames.allTextContents()).toEqual(['First note for user A', 'Second note for user A']);
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
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '笔记 First note for user A' })).toHaveCount(0);
    // A conversation tab opens straight into a conversation, named by its first question.
    await expect(tablist.getByRole('tab', { name: '会话 新对话' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(tablist.getByRole('tab', { name: /^会话 / })).toHaveCount(2);
    await expect(tablist.getByRole('tab', { name: /^会话 / }).last()).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '主页', exact: true }).click();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: '闪卡 记忆闪卡' })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('button', { name: '新建标签页' }).click();
    await expect(tablist.getByRole('tab', { name: '闪卡 记忆闪卡' })).toHaveCount(2);
    await page.getByRole('button', { name: '主页', exact: true }).click();
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
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(tablist.getByRole('tab', { name: /^会话 / }).last()).toHaveAttribute('aria-selected', 'true');
  });

  test('keeps a failed Agent message draft and renders a successful reply as Markdown', async ({ page }) => {
    const state = defaultState();
    state.sendError = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await expect(composer).toBeEnabled();
    await composer.fill('请解释主动回忆');
    await composer.press('Enter');
    // An error response with nothing stored is a failed turn: say why, keep the draft.
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('alert')).not.toContainText('未确认');
    await expect(composer).toHaveValue('请解释主动回忆');
    state.sendError = false;
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.user')).toContainText('请解释主动回忆');
    await expect(page.locator('.chat-message.assistant strong')).toHaveText('已收到');
    await expect(composer).toHaveValue('');
    expect(state.sentRequests).toHaveLength(2);
    expect(state.sentRequests[0].client_request_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('an unconfirmed Agent request from before a reload never blocks new messages', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const requestId = '1234567890abcdef1234567890abcdef';
    const digest = createHash('sha256').update('请解释主动回忆').digest('hex');
    await page.addInitScript(([session, id, hash]) => sessionStorage.setItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${session}`,
      JSON.stringify({ sessionId: session, id, digest: hash })), [sessionA.id, requestId, digest]);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await expect(composer).toBeEnabled();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Resending the same text reuses its request id; other text is a new message.
    await composer.fill('请解释主动回忆');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText('已收到');
    await composer.fill('改成另一个问题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect.poll(() => state.sentRequests.length).toBe(2);
    expect(state.sentRequests[0].client_request_id).toBe(requestId);
    expect(state.sentRequests[1].client_request_id).not.toBe(requestId);
    await page.reload();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('recovers a completed Agent turn when its POST response is lost', async ({ page }) => {
    const state = defaultState();
    state.dropReply = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await composer.fill('回顾今天');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.user')).toHaveText(/回顾今天/);
    await expect(page.locator('.chat-message.assistant')).toContainText('已收到');
    await expect(composer).toHaveValue('');
    expect(state.sentRequests).toHaveLength(1);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });

  test('reconciles a committed Agent turn after both the response and readback fail', async ({ page }) => {
    const state = defaultState();
    state.dropReply = true;
    await mockWorkspace(page, state);
    let failReadback = false;
    await page.route(`**/api/sessions/${sessionA.id}`, route => {
      if (failReadback && route.request().method() === 'GET') {
        failReadback = false;
        return json(route, 503, { error: { id: 'library_storage_unavailable' } });
      }
      return route.fallback();
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await expect(composer).toBeEnabled();
    failReadback = true;
    await composer.fill('总结课程');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('发送结果未确认');
    expect(state.sentRequests).toHaveLength(1);
    await expect(composer).toHaveValue('总结课程');

    await page.evaluate(id => sessionStorage.removeItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${id}`), sessionA.id);
    await page.getByRole('button', { name: '确认发送结果' }).click();
    await expect(page.locator('.chat-message.user')).toContainText('总结课程');
    await expect(page.locator('.chat-message.assistant')).toContainText('已收到');
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.sentRequests).toHaveLength(1);
    await composer.fill('继续讨论');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.user')).toHaveCount(2);
    expect(state.sentRequests).toHaveLength(2);
    expect(state.sentRequests[1].client_request_id).not.toBe(state.sentRequests[0].client_request_id);

    await page.reload();
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.locator('.chat-message.user').first()).toContainText('总结课程');
    await expect(page.locator('.chat-message.assistant').first()).toContainText('已收到');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.sentRequests).toHaveLength(2);
    expect(await page.evaluate(id => sessionStorage.getItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${id}`), sessionA.id)).toBeNull();
  });

  test('reports a server turn that reuses the request id with different content', async ({ page }) => {
    const state = defaultState();
    const requestId = '1234567890abcdef1234567890abcdef';
    state.sessionById[sessionA.id] = { ...sessionA, messages: [
      { role: 'user', content: '不同的内容', client_request_id: requestId, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '不应被确认', created_at: '2026-01-01T00:00:11.000Z' },
    ] };
    await mockWorkspace(page, state);
    const digest = createHash('sha256').update('原始消息').digest('hex');
    await page.addInitScript(([session, id, hash]) => sessionStorage.setItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${session}`,
      JSON.stringify({ sessionId: session, id, digest: hash })), [sessionA.id, requestId, digest]);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('服务器记录与原消息不一致');
    expect(state.sentRequests).toHaveLength(0);
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

  test('edits a server-created sample flashcard without creating a duplicate', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const deck = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const cards = [];
    let posts = 0;
    let patches = 0;
    await page.route('**/api/decks', route => json(route, 200, { decks: [deck] }));
    await page.route('**/api/cards**', route => {
      const method = route.request().method();
      if (method === 'GET') return json(route, 200, { cards });
      if (method === 'POST') {
        const input = route.request().postDataJSON();
        posts++;
        const card = { ...input, id: posts.toString(16).padStart(32, 'a'), deck_id: deck.id,
          due: new Date().toISOString(), interval: 0, ease: 250, reps: 0, lapses: 0 };
        cards.push(card);
        return json(route, 201, { card });
      }
      if (method === 'PATCH') {
        patches++;
        const card = cards.find(item => route.request().url().endsWith(item.id));
        if (!card) return json(route, 404, { error: { id: 'card_not_found' } });
        Object.assign(card, route.request().postDataJSON());
        return json(route, 200, { card });
      }
      return json(route, 404, { error: { id: 'card_not_found' } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '加载 4 张示例卡片' }).click();
    await expect(page.locator('.anki-browser-row')).toHaveCount(4);
    await page.locator('.anki-browser-front').first().click();
    await page.getByRole('textbox', { name: '正面' }).fill('编辑后的问题');
    await expect.poll(() => patches).toBe(1);
    expect(posts).toBe(4);
    expect(cards).toHaveLength(4);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-row')).toHaveCount(4);
    await expect(page.locator('.anki-browser-front strong').first()).toHaveText('编辑后的问题');
  });

  test('imports TSV through the server as a new deck and reloads it', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const initial = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const imported = { ...initial, id: 'abababababababababababababababad', name: '考前复习' };
    const decks = [initial];
    const cards = [];
    let imports = 0;
    let individualCreates = 0;
    await page.route('**/api/decks', route => json(route, 200, { decks }));
    await page.route('**/api/cards**', route => {
      if (route.request().method() === 'POST') individualCreates++;
      return json(route, 200, { cards: cards.filter(card => new URL(route.request().url()).searchParams.get('deck_id') === card.deck_id) });
    });
    await page.route('**/api/decks/import', route => {
      imports++;
      const input = route.request().postDataJSON();
      expect(input).toEqual({ name: '考前复习', tsv: '问题\t答案\t期末 重点\n' });
      decks.push(imported);
      cards.push({ id: 'abababababababababababababababae', deck_id: imported.id, front: '问题', back: '答案',
        tags: ['期末', '重点'], due: new Date().toISOString(), interval: 0, ease: 250, reps: 0, lapses: 0 });
      return json(route, 201, { deck: imported, cards });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-workspace input[type=file]').setInputFiles({
      name: '考前复习.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('问题\t答案\t期末 重点\n'),
    });
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('问题');
    await expect(page.locator('.anki-title-block h1')).toHaveText('考前复习');
    expect(imports).toBe(1);
    expect(individualCreates).toBe(0);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-sidebar-deck').filter({ hasText: '考前复习' }).click();
    await expect(page.locator('.anki-review-card')).toContainText('问题');
    await expect(page.locator('.anki-title-block h1')).toHaveText('考前复习');
  });

  test('failed server TSV import keeps the current flashcard deck unchanged', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const deck = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const card = { id: 'abababababababababababababababad', deck_id: deck.id, front: '现有卡片', back: '答案',
      due: new Date().toISOString(), interval: 0, ease: 250, reps: 0, lapses: 0 };
    await page.route('**/api/decks', route => json(route, 200, { decks: [deck] }));
    await page.route('**/api/cards**', route => json(route, 200, { cards: [card] }));
    await page.route('**/api/decks/import', route => json(route, 503, { error: { id: 'anki_storage_unavailable' } }));
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-workspace input[type=file]').setInputFiles({
      name: '错误.tsv', mimeType: 'text/tab-separated-values', buffer: Buffer.from('问题\t答案\n'),
    });
    await expect(page.getByText('导入闪卡失败，原有牌组未更改；请检查文件格式后重试。')).toBeVisible();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('现有卡片');
    await expect(page.locator('.anki-sidebar-deck')).toHaveCount(1);
  });

  test('creates, edits and reviews flashcards through the authenticated API', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    const cards = [];
    const deck = { id: 'abababababababababababababababac', name: '默认牌组', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    let reviews = 0;
    const reviewLog = [];
    state.ankiByOwner[syntheticSessionA.id] = { decks: [deck], cards, reviews: reviewLog };
    await page.route('**/api/decks', route => json(route, 200, { decks: [deck] }));
    await page.route('**/api/cards**', route => {
      const url = new URL(route.request().url());
      const method = route.request().method();
      if (method === 'GET') return json(route, 200, { cards });
      if (method === 'POST') {
        const input = route.request().postDataJSON();
        const card = {
          id: (cards.length + 1).toString(16).padStart(32, 'a'), deck_id: deck.id,
          front: input.front, back: input.back, tags: input.tags,
          due: new Date(Date.now() - 1000).toISOString(), interval: 0, ease: 250,
          reps: 0, lapses: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        };
        cards.push(card);
        return json(route, 201, { card });
      }
      const card = cards.find(item => url.pathname.endsWith(item.id));
      if (method === 'PATCH' && card) {
        Object.assign(card, route.request().postDataJSON());
        return json(route, 200, { card });
      }
      if (method === 'DELETE' && card) {
        cards.splice(cards.indexOf(card), 1);
        return json(route, 200, { ok: true });
      }
      return json(route, 404, { error: { id: 'card_not_found' } });
    });
    await page.route('**/api/reviews', route => {
      if (route.request().method() === 'GET') return json(route, 200, { reviews: reviewLog });
      reviews++;
      const { card_id, client_request_id } = route.request().postDataJSON();
      const card = cards.find(item => item.id === card_id);
      card.reps++;
      card.due = new Date(Date.now() + 86400000).toISOString();
      const review = { card_id, client_request_id, reviewed_at: new Date().toISOString() };
      reviewLog.push(review);
      return json(route, 200, { card, review });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '新建卡片' }).click();
    await page.getByRole('textbox', { name: '正面' }).fill('<img src=x onerror=alert(1)>');
    await page.getByRole('textbox', { name: '背面' }).fill('测试答案');
    await expect.poll(() => cards[0]?.back).toBe('测试答案');
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('<img src=x onerror=alert(1)>');
    await page.locator('.anki-sidebar-deck').click();
    await page.locator('.anki-review-card').click();
    await expect(page.locator('.anki-review-card img')).toHaveCount(0);
    await page.getByRole('button', { name: /良好/ }).click();
    await expect.poll(() => reviews).toBe(1);
    await expect(page.getByText('还没有学习记录')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-row .is-review')).toHaveCount(1);
    await page.getByRole('button', { name: '学习概览' }).click();
    await expect(page.locator('.anki-panel-note')).toContainText('上次学习于');
    expect(cards[0].reps).toBe(1);
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await page.locator('.anki-browser-row button[aria-label^="删除"]').click();
    await expect.poll(() => cards.length).toBe(0);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();
  });

  test('loads each deck study summary without downloading review history', async ({ page }) => {
    const state = defaultState();
    const deckA = { id: 'abababababababababababababababac', name: '高数',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const deckB = { ...deckA, id: 'abababababababababababababababad', name: '英语' };
    const cardA = { id: 'abababababababababababababababae', deck_id: deckA.id, front: '导数', back: '答案',
      due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 1, lapses: 0 };
    const cardB = { ...cardA, id: 'abababababababababababababababaf', deck_id: deckB.id, front: '单词' };
    state.ankiByOwner[syntheticSessionA.id] = {
      decks: [deckA, deckB], cards: [cardA, cardB],
      reviews: [{ card_id: cardA.id, reviewed_at: '2026-09-25T09:00:00Z' }],
    };
    await mockWorkspace(page, state);
    let historyReads = 0;
    await page.route('**/api/reviews', route => {
      historyReads++;
      return json(route, 503, { error: { id: 'history_unavailable' } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.locator('.anki-panel-note')).toContainText('上次学习于');
    await page.locator('.anki-sidebar-deck').filter({ hasText: '英语' }).click();
    await page.getByRole('button', { name: '退出学习' }).click();
    await expect(page.locator('.anki-panel-note')).toHaveText('还没有学习记录');
    await page.locator('.anki-sidebar-deck').filter({ hasText: '高数' }).click();
    await page.getByRole('button', { name: '退出学习' }).click();
    await expect(page.locator('.anki-panel-note')).toContainText('上次学习于');
    expect(historyReads).toBe(0);
  });

  test('manages server decks and reloads the remaining deck after deletion', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    const owner = state.ankiByOwner[syntheticSessionA.id];
    const defaultDeck = owner.decks[0];
    await expect(page.getByRole('button', { name: `删除牌组 ${defaultDeck.name}` })).toBeDisabled();
    page.once('dialog', dialog => dialog.accept('考前复习'));
    await page.getByRole('button', { name: '新建牌组' }).click();
    await expect(page.locator('.anki-title-block h1')).toHaveText('考前复习');
    const created = owner.decks.find(deck => deck.id !== defaultDeck.id);
    expect(created?.name).toBe('考前复习');
    await page.getByRole('button', { name: '新建卡片' }).click();
    await page.getByRole('textbox', { name: '正面' }).fill('第二牌组的卡片');
    await expect.poll(() => owner.cards.find(card => card.deck_id === created.id)?.front).toBe('第二牌组的卡片');
    page.once('dialog', dialog => dialog.accept('期末复习'));
    await page.getByRole('button', { name: '重命名牌组 考前复习' }).click();
    await expect(page.locator('.anki-title-block h1')).toHaveText('期末复习');
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-sidebar-deck').filter({ hasText: '期末复习' }).click();
    await expect(page.locator('.anki-review-card')).toContainText('第二牌组的卡片');
    await page.getByRole('button', { name: '退出学习' }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('第二牌组的卡片');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除牌组 期末复习' }).click();
    await expect(page.locator('.anki-title-block h1')).toHaveText(defaultDeck.name);
    expect(owner.cards).toHaveLength(0);
    expect(owner.decks).toEqual([defaultDeck]);
    await expect(page.getByRole('button', { name: `删除牌组 ${defaultDeck.name}` })).toBeDisabled();
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
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送给 Agent 的消息' })).toBeVisible();
    await expect(page.locator('.conversation-row')).toHaveCount(1);
  });

  test('discards a previous identity flashcard response that arrives after account switch', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    let releaseCards;
    const deck = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    await page.route('**/api/decks', route => json(route, 200, { decks: [deck] }));
    await page.route('**/api/cards?*', async route => {
      if (state.session.id === syntheticSessionA.id) {
        await new Promise(resolve => { releaseCards = resolve; });
        return json(route, 200, { cards: [{ id: 'old-card', deck_id: deck.id, front: 'A 的私有卡片',
          back: '仅属于 A', due: new Date().toISOString(), interval: 0, ease: 250, reps: 0, lapses: 0 }] });
      }
      return json(route, 200, { cards: [] });
    });
    await page.goto('/workspace');
    await expect.poll(() => typeof releaseCards).toBe('function');
    state.session = syntheticSessionB;
    state.libraries = [libB];
    state.entries = [guideB];
    state.entryById = { [guideB.id]: guideB };
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();
    releaseCards();
    await expect(page.getByText('A 的私有卡片')).toHaveCount(0);
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();
  });

  test('keeps server folders and flashcards separate between identities', async ({ page }) => {
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
    await expect.poll(() => state.ankiByOwner[syntheticSessionA.id]?.cards[0]?.front).toBe('A 的卡片');
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '主页', exact: true }).click();
    const ownerAEntries = state.entries.slice();

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
    state.entries = ownerAEntries;
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
    await expect(page.getByRole('button', { name: 'A 私有目录' })).toBeVisible();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByRole('button', { name: 'A 的卡片', exact: true })).toBeVisible();
  });

  test('pauses flashcard editing on API outage and reconnects to server data', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    let offline = true;
    await page.route('**/api/decks', route => offline
      ? json(route, 503, { error: { id: 'anki_storage_unavailable' } })
      : route.fallback());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.getByRole('region', { name: '闪卡服务不可用' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建卡片' })).toBeDisabled();
    expect(state.ankiByOwner[syntheticSessionA.id]?.cards ?? []).toHaveLength(0);
    offline = false;
    await page.getByRole('button', { name: '重试连接' }).click();
    await expect(page.getByText('还没有记忆闪卡')).toBeVisible();
    await expect(page.getByRole('button', { name: '新建卡片' })).toBeEnabled();
  });

  test('preserves an unconfirmed card edit for export after a failed write', async ({ page }) => {
    const state = defaultState();
    const deck = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const card = { id: 'abababababababababababababababad', deck_id: deck.id, front: '服务端原文', back: '答案',
      due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 0, lapses: 0 };
    state.ankiByOwner[syntheticSessionA.id] = { decks: [deck], cards: [card] };
    await mockWorkspace(page, state);
    await page.route(`**/api/cards/${card.id}`, route => route.request().method() === 'PATCH'
      ? json(route, 503, { error: { id: 'anki_storage_unavailable' } })
      : route.fallback());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await page.locator('.anki-browser-front').click();
    await page.getByRole('textbox', { name: '正面' }).fill('尚未确认的修改');
    await expect(page.getByRole('region', { name: '闪卡服务不可用' })).toBeVisible();
    await expect(page.getByRole('button', { name: '新建卡片' })).toBeDisabled();
    const backup = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出当前卡片备份' }).click();
    const saved = await backup;
    expect(await readFile(await saved.path(), 'utf8')).toContain('尚未确认的修改');
    expect(card.front).toBe('服务端原文');
    await page.getByRole('button', { name: '重试连接' }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('服务端原文');
  });

  test('retries a lost review response with the same request ID without double scheduling', async ({ page }) => {
    const state = defaultState();
    const deck = { id: 'abababababababababababababababac', name: '默认牌组',
      created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    const card = { id: 'abababababababababababababababad', deck_id: deck.id, front: '复习题', back: '答案',
      due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 0, lapses: 0 };
    state.ankiByOwner[syntheticSessionA.id] = { decks: [deck], cards: [card] };
    await mockWorkspace(page, state);
    const requests = [];
    await page.route('**/api/reviews', route => {
      if (route.request().method() === 'GET') return json(route, 200, { reviews: [] });
      const input = route.request().postDataJSON();
      requests.push(input);
      if (requests.length === 1) {
        card.reps++;
        card.due = new Date(Date.now() + 86400000).toISOString();
        return route.abort('failed');
      }
      return json(route, 200, { card, review: {
        card_id: input.card_id, client_request_id: input.client_request_id, reviewed_at: new Date().toISOString(),
      } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-sidebar-deck').click();
    await page.locator('.anki-review-card').click();
    await page.getByRole('button', { name: /良好/ }).click();
    await expect(page.getByText('复习结果未确认；请用相同评分重试，系统不会重复计入。')).toBeVisible();
    await page.getByRole('button', { name: /良好/ }).click();
    await expect.poll(() => requests.length).toBe(2);
    expect(requests[0]).toEqual(requests[1]);
    expect(requests[0].client_request_id).toMatch(/^[0-9a-f]{32}$/);
    expect(card.reps).toBe(1);
    await expect.poll(() => page.evaluate(({ owner, id }) =>
      sessionStorage.getItem(`tjuclaw.anki.review.pending.v1.${owner}.${id}`),
    { owner: syntheticSessionA.id, id: card.id })).toBeNull();
  });

  for (const scenario of ['uncommitted', 'committed', 'other-device']) {
    test(`reconciles a ${scenario} review after page reload`, async ({ page }) => {
      const state = defaultState();
      const deck = { id: 'abababababababababababababababac', name: '默认牌组',
        created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
      const card = { id: 'abababababababababababababababad', deck_id: deck.id, front: '复习题', back: '答案',
        due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 0, lapses: 0 };
      state.ankiByOwner[syntheticSessionA.id] = { decks: [deck], cards: [card] };
      await mockWorkspace(page, state);
      const requests = [];
      await page.route('**/api/reviews/requests/*', route => {
        const requestId = route.request().url().split('/').pop();
        if (scenario === 'committed' && requests[0]?.client_request_id === requestId) {
          return json(route, 200, { review: { id: 'review', card_id: card.id, rating: 3, client_request_id: requestId } });
        }
        return json(route, 404, { error: { id: 'review_request_not_found' } });
      });
      await page.route('**/api/reviews', route => {
        if (route.request().method() === 'GET') return json(route, 200, { reviews: [] });
        const input = route.request().postDataJSON();
        requests.push(input);
        if (requests.length === 1) {
          if (scenario === 'committed') {
            card.reps++;
            card.due = new Date(Date.now() + 86400000).toISOString();
          } else if (scenario === 'other-device') {
            card.reps++;
          }
          return route.abort('failed');
        }
        card.reps++;
        return json(route, 200, { card, review: {
          card_id: input.card_id, client_request_id: input.client_request_id, reviewed_at: new Date().toISOString(),
        } });
      });
      await page.goto('/workspace');
      await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
      await page.locator('.anki-sidebar-deck').click();
      await page.locator('.anki-review-card').click();
      await page.getByRole('button', { name: /良好/ }).click();
      await expect(page.getByText('复习结果未确认；请用相同评分重试，系统不会重复计入。')).toBeVisible();
      const pendingKey = `tjuclaw.anki.review.pending.v1.${syntheticSessionA.id}.${card.id}`;
      await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), pendingKey)).not.toBeNull();
      await page.reload();
      await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
      await expect(page.locator('.anki-sidebar-deck')).toHaveCount(1);
      if (scenario === 'committed') {
        await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), pendingKey)).toBeNull();
        expect(card.reps).toBe(1);
      } else {
        await expect.poll(() => page.evaluate(key => sessionStorage.getItem(key), pendingKey)).not.toBeNull();
        await page.locator('.anki-sidebar-deck').click();
        await page.locator('.anki-review-card').click();
        await page.getByRole('button', { name: /良好/ }).click();
        await expect.poll(() => requests.length).toBe(2);
        expect(requests[0].client_request_id).toBe(requests[1].client_request_id);
        expect(card.reps).toBe(scenario === 'other-device' ? 2 : 1);
      }
    });
  }

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

  test('keeps a failed note save visible, blocks navigation, and retries the same draft', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = { ...noteC };
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
    await expect(page.locator('.workspace-statusbar')).toContainText('保存失败 · 当前内容未保存');
    await page.getByRole('button', { name: 'Second note for user A', exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue(noteA.title);
    await expect(editor).toContainText('Edited body still here');
    state.patchError = false;
    await page.getByRole('button', { name: '重试保存' }).click();
    await expect.poll(() => state.entryById[noteA.id].body).toBe('Edited body still here');
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
    await page.getByRole('button', { name: 'Second note for user A', exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue(noteC.title);
  });

  test('confirms a lost note PATCH response without overwriting its committed revision', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    let attempts = 0;
    await page.route(`**/api/entries/${noteA.id}`, route => {
      if (route.request().method() === 'GET') return json(route, 200, { entry: state.entryById[noteA.id] });
      const patch = route.request().postDataJSON();
      attempts++;
      const previous = state.entryById[noteA.id];
      if (patch.expected_updated_at !== previous.updated_at) {
        return json(route, 409, { error: { id: 'entry_conflict' } });
      }
      state.entryById[noteA.id] = { ...previous, ...patch, updated_at: '2026-01-01T00:00:03.000Z' };
      return route.abort('failed');
    });
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Committed while response was lost');
    await expect(page.getByRole('button', { name: '重试保存' })).toBeVisible();
    await page.getByRole('button', { name: '重试保存' }).click();
    await expect.poll(() => attempts).toBe(2);
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
    await expect(page.getByRole('button', { name: '重试保存' })).toHaveCount(0);
    await expect(editor).toContainText('Committed while response was lost');
  });

  test('recovers a note save that fails after switching to another note', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = { ...noteC };
    await mockWorkspace(page, state);
    let releaseSave;
    const heldSave = new Promise(resolve => { releaseSave = resolve; });
    let attempts = 0;
    await page.route(`**/api/entries/${noteA.id}`, async route => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      attempts++;
      if (attempts === 1) {
        await heldSave;
        return json(route, 503, { error: { id: 'library_storage_unavailable' } });
      }
      return route.fallback();
    });
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('Draft saved after switching back');
    await page.getByRole('button', { name: 'Second note for user A', exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue(noteC.title);
    await expect.poll(() => attempts).toBe(1);
    releaseSave();
    await expect(page.getByRole('button', { name: '返回未保存笔记' })).toBeVisible();
    await expect(page.locator('.workspace-statusbar')).toContainText('另一篇笔记未保存');
    await page.getByRole('button', { name: '返回未保存笔记' }).click();
    await expect(editor).toContainText('Draft saved after switching back');
    await page.getByRole('button', { name: '重试保存' }).click();
    await expect.poll(() => state.entryById[noteA.id].body).toBe('Draft saved after switching back');
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
  });

  test('keeps a genuine server revision conflict separate from the local draft', async ({ page }) => {
    const state = defaultState();
    state.entries.push(noteC);
    state.entryById[noteC.id] = { ...noteC };
    await mockWorkspace(page, state);
    await page.route(`**/api/entries/${noteA.id}`, route => {
      if (route.request().method() === 'PATCH') return json(route, 409, { error: { id: 'entry_conflict' } });
      return route.fallback();
    });
    await page.goto('/workspace');
    state.entryById[noteA.id] = { ...state.entryById[noteA.id], body: 'Other device version', updated_at: '2026-01-01T00:00:03.000Z' };
    const editor = page.locator('.codemirror-editor .cm-content');
    await editor.click();
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.type('My local draft');
    await expect(page.getByRole('button', { name: '加载云端版本' })).toBeVisible();
    await expect(editor).toContainText('My local draft');
    await page.getByRole('button', { name: 'Second note for user A', exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue(noteA.title);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '加载云端版本' }).click();
    await expect(editor).toContainText('Other device version');
    await expect(page.locator('.workspace-statusbar')).toContainText('已保存');
  });

  test('shows knowledge tree and guide without claiming execution', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await expect(page.locator('.sidebar-library-button')).toContainText('我的知识库');
    await page.getByRole('button', { name: '工作', exact: true }).click();
    await expect(page.getByRole('textbox', { name: '发送给 Agent 的消息' })).toBeVisible();
    await expect(page.getByText('已保存 (draft)')).toHaveCount(0);
    await expect(page.getByText('执行记录与运行')).toHaveCount(0);
  });

  test('does not claim product NewAPI when fallback is missing', async ({ page }) => {
    const state = defaultState();
    state.model = { configured: false, source: 'none', quota: { limit: 20, used: 0, remaining: 20 } };
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: '工作', exact: true }).click();
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
    const editorBox = await page.locator('.note-editor').boundingBox();
    const topbarBox = await page.locator('.obsidian-topbar').boundingBox();
    expect(arrowBox.x - mainBox.x).toBeGreaterThan(0);
    expect(arrowBox.x - mainBox.x).toBeLessThan(60);
    expect(arrowBox.y).toBeGreaterThan(topbarBox.y + topbarBox.height);
    expect(arrowBox.y - editorBox.y).toBeGreaterThanOrEqual(0);
    expect(arrowBox.y - editorBox.y).toBeLessThan(80);
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
    await page.locator('.notion-side-head').getByRole('button', { name: '收起侧栏' }).click();
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
  expect(leftBox.width).toBe(9);
  // Notion-width sidebar: 18% of a 1440px window (259px), no separate icon rail.
  const sidebarWidth = 259;
  expect(leftBox.x + leftBox.width / 2).toBe(sidebarWidth);
  expect(await sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(sidebarWidth);
  // No right panel: the page takes everything beside the sidebar.
  expect(await page.locator('.obsidian-main').evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(1440 - sidebarWidth);
  expect(await left.evaluate(element => getComputedStyle(element, '::after').width)).toBe('2px');
  await page.mouse.move(sidebarWidth, 200);
  await expect.poll(() => left.evaluate(element => getComputedStyle(element, '::after').backgroundColor)).not.toBe(inactive);
  await page.mouse.down();
  await page.mouse.move(384, 200, { steps: 5 });
  await page.mouse.up();
  await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().width))).toBe(384);

  // The outline lives in the sidebar (文件 | 大纲); there is no right panel.
  await expect(page.locator('.obsidian-rail')).toHaveCount(0);
  await expect(page.getByRole('separator', { name: '调整右侧面板宽度' })).toHaveCount(0);
  await page.getByRole('tab', { name: '大纲', exact: true }).click();
  await expect(page.getByRole('tab', { name: '大纲' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '文件', exact: true }).click();
  await expect(page.getByRole('tab', { name: '文件' })).toHaveAttribute('aria-selected', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(left).toBeHidden();
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
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeHidden();
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
  await page.getByRole('button', { name: '关闭操作菜单' }).click({ position: { x: 24, y: 24 } });
  await page.getByRole('button', { name: 'First note for user A', exact: true }).click();
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);

  await page.getByRole('button', { name: '更多操作' }).click();
  await expect(page.getByRole('menu', { name: '文档操作' })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-actions.png' });
  await page.getByRole('menuitem', { name: '大纲' }).click();
  const outline = page.locator('.notes-outline-pane');
  await expect(outline.getByRole('button', { name: '今日计划', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/workspace/mobile-outline.png' });
  await outline.getByRole('button', { name: '今日计划', exact: true }).click();
  await expect(page.locator('.obsidian-sidebar')).toHaveAttribute('aria-hidden', 'true');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('tab', { name: '文件' }).click();
  await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 350 } });
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

test('mobile drawer uses the Notion sidebar with motion-aware dismissal', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  const sidebar = page.locator('.obsidian-sidebar');
  const home = sidebar.getByRole('button', { name: '主页', exact: true });
  const positions = await page.evaluate(() => {
    const rect = selector => document.querySelector(selector).getBoundingClientRect();
    return { head: rect('.notion-side-head').toJSON(), nav: rect('.notion-nav').toJSON(), tree: rect('.obsidian-tree').toJSON(), apps: rect('.notion-apps').toJSON() };
  });
  // Workspace switcher, then the pill nav, the section's list and the apps.
  expect(positions.head.bottom).toBeLessThanOrEqual(positions.nav.top + 1);
  expect(positions.nav.bottom).toBeLessThanOrEqual(positions.tree.top + 1);
  expect(positions.tree.bottom).toBeLessThanOrEqual(positions.apps.top + 1);
  await expect(home).toHaveAttribute('aria-current', 'page');
  await sidebar.getByRole('button', { name: '工作', exact: true }).click();
  await expect(sidebar.getByRole('button', { name: '工作', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(home).not.toHaveAttribute('aria-current', 'page');
  await home.click();
  await page.screenshot({ path: 'test-results/workspace/mobile-notion-sidebar.png' });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({ path: 'test-results/workspace/mobile-notion-sidebar-dark.png' });
  await page.locator('.mobile-sidebar-backdrop').click({ position: { x: 380, y: 350 } });
  await expect(sidebar).toHaveAttribute('inert', '');
  await expect.poll(() => sidebar.evaluate(element => element.getBoundingClientRect().right)).toBeLessThanOrEqual(1);
  await expect(page.locator('.mobile-sidebar-backdrop')).toBeHidden();
  // Home has the composer at its foot; a note or session does not.
  await expect(page.getByRole('form', { name: '问 TJUClaw' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(true);
});

test('plugins live in Settings and open the real built-in features', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  const skills = [{ id: 'lab-report', title: '实验报告', summary: '按规范结构整理数据和结论', description: '整理成结构完整的实验报告。', enabled: false }];
  const toggles = [];
  await page.route('**/api/account/skills**', route => {
    const request = route.request();
    if (request.method() === 'PUT') {
      toggles.push([new URL(request.url()).pathname, JSON.parse(request.postData())]);
      skills[0].enabled = JSON.parse(request.postData()).enabled;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skill: skills[0] }) });
    }
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ skills }) });
  });
  await page.goto('/workspace');
  const activity = page.locator('.obsidian-sidebar');
  await expect(activity.getByRole('button', { name: '插件' })).toHaveCount(0);
  const openPlugins = async () => {
    await activity.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '插件' }).click();
  };
  await openPlugins();
  // Skills are enabled here; the Agent reads one when a task fits it.
  const lab = page.getByRole('dialog').getByRole('article', { name: '实验报告' });
  await expect(lab.getByText('按规范结构整理数据和结论')).toBeVisible();
  await lab.getByRole('checkbox', { name: '启用「实验报告」' }).click();
  await expect(lab.getByText('已启用')).toBeVisible();
  expect(toggles).toEqual([['/api/account/skills/lab-report', { enabled: true }]]);
  await page.getByRole('button', { name: /打开知识图谱/ }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('navigation', { name: '设置分类' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await openPlugins();
  await page.getByRole('button', { name: /打开记忆闪卡/ }).click();
  await expect(page.getByRole('region', { name: 'Anki 记忆闪卡' }).getByRole('heading', { level: 1 })).toBeVisible();
  await expect(activity.getByRole('button', { name: '记忆闪卡' })).toHaveAttribute('aria-current', 'page');
});

test('the phone drawer follows a swipe: closed from the drawer, opened from the edge, and a short swipe springs back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  const app = page.locator('.obsidian-app');
  const sidebar = page.locator('.obsidian-sidebar');
  // Touch pointers as a finger produces them; the drawer listens on the app.
  const swipe = (selector, from, to, steps = 8) => page.evaluate(({ selector, from, to, steps }) => {
    const target = document.querySelector(selector);
    const fire = (type, x) => target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 420 }));
    fire('pointerdown', from);
    for (let step = 1; step <= steps; step++) fire('pointermove', from + (to - from) * step / steps);
    fire('pointerup', to);
  }, { selector, from, to, steps });

  await page.getByRole('button', { name: '打开侧栏' }).click();
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
  await expect.poll(() => sidebar.evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0);
  // A short swipe is not enough: the drawer settles back open.
  await swipe('.obsidian-sidebar .notion-apps', 200, 160);
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
  expect(await sidebar.evaluate(element => element.style.transform)).toBe('');
  // A long one closes it.
  await swipe('.obsidian-sidebar .notion-apps', 300, 60);
  await expect(app).toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.mobile-sidebar-backdrop')).toBeHidden();
  // From the screen's left edge, a swipe right opens it again.
  await swipe('.mobile-drawer-edge', 4, 260);
  await expect(app).not.toHaveClass(/sidebar-collapsed/);
  await expect(page.locator('.mobile-sidebar-backdrop')).toBeVisible();
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
  await expect(page.locator('.mobile-sidebar-backdrop')).toBeHidden();
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
  await page.getByRole('button', { name: '快速切换', exact: true }).focus();
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

for (const colorScheme of ['light', 'dark']) test(`todo checkbox keeps its geometry when toggled (${colorScheme})`, async ({ page }) => {
  await page.emulateMedia({ colorScheme });
  const state = defaultState();
  const body = '- [ ] 待办任务\n- [x] 已完成任务\n  - [ ] 嵌套任务';
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  // Exclude CodeMirror's temporary sizing widgets outside the document.
  const boxes = page.locator('.cm-content .cm-md-checkbox');
  await expect(boxes).toHaveCount(3);
  const geometry = () => boxes.evaluateAll(elements => elements.map(element => {
    const box = element.getBoundingClientRect();
    const line = element.closest('.cm-line').getBoundingClientRect();
    return { x: box.x, y: box.y, height: box.height, lineHeight: line.height };
  }));
  const before = await geometry();
  for (const index of [0, 1, 2, 2, 1, 0]) {
    await boxes.nth(index).click();
    await expect.poll(geometry).toEqual(before);
  }
  await expect.poll(() => state.entryById[noteA.id].body).toBe(body);
  // Start fresh history: rapid mouse toggles can be grouped into one undo event.
  await page.reload();
  await expect(boxes).toHaveCount(3);
  await boxes.first().focus();
  await page.keyboard.press('Space');
  await expect(boxes.first()).toBeChecked();
  await expect.poll(geometry).toEqual(before);
  await boxes.first().focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(boxes.first()).not.toBeChecked();
  // Undo focuses the editor and reveals list syntax; compare preview after blur.
  await page.getByRole('button', { name: '快速切换', exact: true }).focus();
  await expect.poll(geometry).toEqual(before);
  await expect.poll(() => state.entryById[noteA.id].body).toBe(body);
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
  // The number and its spaces become one fixed-width marker, so no stray
  // spaces are left in front of the text and wrapped lines can hang.
  expect(await ordered.locator('.cm-md-ordered-marker').textContent()).toBe('1.');
  expect(await ordered.textContent()).toBe('1.顺序');
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
  // The page font follows the appearance preference: system sans by default,
  // Cascadia with WenKai when the monospace page font is chosen.
  expect(loneMarker.font).toContain('-apple-system');
  await page.evaluate(() => { document.documentElement.dataset.font = 'mono'; });
  await expect(page.locator('.codemirror-editor .cm-scroller')).toHaveCSS('font-family', /Cascadia Code.*LXGW WenKai/);
  await page.evaluate(() => { document.documentElement.dataset.font = 'serif'; });
  await expect(page.locator('.codemirror-editor .cm-scroller')).toHaveCSS('font-family', /^"?LXGW WenKai/);
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
  await page.getByRole('button', { name: '快速切换', exact: true }).focus();
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
  expect((await menu.boundingBox()).width).toBeLessThanOrEqual(240);
  await expect(page.getByRole('toolbar', { name: 'Markdown 格式工具栏' })).toHaveCount(0);
  await menu.getByRole('button', { name: '加粗' }).click();
  await expect(editor).toContainText('Private note body');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('**Private note body**');
  await expect(menu).toHaveCount(0);
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '加粗' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  // 段落 opens a submenu of headings, with the current one checked.
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '段落' }).hover();
  const paragraph = menu.getByRole('menu', { name: '段落' });
  await expect(paragraph.getByRole('menuitem', { name: /^段落/ })).toContainText(/Ctrl\+0|⌘0/);
  await paragraph.getByRole('menuitem', { name: /二级标题/ }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('## Private note body');
  await editor.click({ button: 'right' });
  await expect(menu.getByRole('button', { name: '加粗' })).toHaveAttribute('aria-pressed', 'false');
  await menu.getByRole('button', { name: '段落' }).click();
  await menu.getByRole('menu', { name: '段落' }).getByRole('menuitem', { name: /^段落/ }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  // Ctrl/⌘+number sets headings, as the menu shows; undo is the usual shortcut.
  await page.keyboard.press('ControlOrMeta+3');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('### Private note body');
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => state.entryById[noteA.id].body).toBe('Private note body');
  await page.keyboard.press('ControlOrMeta+2');
  await page.keyboard.press('ControlOrMeta+a');
  await editor.click({ button: 'right' });
  await menu.getByRole('button', { name: '插入' }).hover();
  await menu.getByRole('menu', { name: '插入' }).getByRole('menuitem', { name: '双向链接' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('[[## Private note body]]');
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
  await page.keyboard.press('ControlOrMeta+a');
  await editor.click({ button: 'right', position: { x: 30, y: 12 } });
  await menu.getByRole('button', { name: '复制／粘贴为…' }).hover();
  await menu.getByRole('menuitem', { name: '复制为纯文本' }).click();
  await editor.click({ button: 'right', position: { x: 30, y: 12 } });
  await menu.getByRole('button', { name: '删除' }).click();
  await expect.poll(() => state.entryById[noteA.id].body).toBe('');
});

test('context options and note rows keep hover and selection colors aligned', async ({ page }) => {
  const state = defaultState();
  const other = { ...noteA, id: '33333333333333333333333333333333', title: 'Other note', created_at: '2026-01-01T00:00:02.000Z' };
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
    const row = menu.getByRole('button', { name: '段落' });
    const other = menu.getByRole('button', { name: '插入' });
    await row.hover();
    const hoverColor = await row.evaluate(element => getComputedStyle(element).backgroundColor);
    expect(hoverColor).not.toBe('rgba(0, 0, 0, 0)');
    await other.hover();
    expect(await other.evaluate(element => getComputedStyle(element).backgroundColor)).toBe(hoverColor);
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
  await expect(page.getByRole('navigation', { name: '快捷操作' })).toBeHidden();
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

test('touch editing keeps native selection and formats from the bar above the keyboard', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const editor = page.locator('.codemirror-editor .cm-content');
    await expect(page.locator('.codemirror-editor.is-touch')).toHaveCount(1);
    // The browser draws the caret and selection handles, not CodeMirror.
    await expect(page.locator('.cm-cursorLayer')).toHaveCount(0);
    const bar = page.getByRole('toolbar', { name: 'Markdown 格式' });
    await expect(bar).toHaveCount(0);
    await editor.tap();
    await expect(bar).toBeVisible();
    await expect(page.locator('.mobile-command-bar')).toBeHidden();
    // Long-press belongs to the system text menu now.
    const box = await editor.boundingBox();
    const point = { pointerType: 'touch', clientX: box.x + 35, clientY: box.y + 20 };
    await editor.dispatchEvent('pointerdown', point);
    await page.waitForTimeout(650);
    await editor.dispatchEvent('pointerup', point);
    await expect(page.getByRole('dialog', { name: 'Markdown 编辑菜单' })).toHaveCount(0);
    await bar.getByRole('button', { name: '无序列表' }).tap();
    await expect.poll(() => state.entryById[noteA.id].body).toBe('- Private note body');
    expect(await page.evaluate(() => document.activeElement?.classList.contains('cm-content'))).toBe(true);
    await bar.getByRole('button', { name: '更多格式' }).tap();
    await expect(page.getByRole('dialog', { name: 'Markdown 编辑菜单' })).toBeVisible();
  } finally {
    await context.close();
  }
});

test('phones replace the tab strip with the page title and a tab sheet', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await expect(page.locator('.obsidian-topbar .workspace-tabs')).toBeHidden();
    const title = page.locator('.mobile-tab-title');
    await expect(title).toContainText(noteA.title);
    await page.getByRole('button', { name: /打开的标签页（1）/ }).tap();
    const sheet = page.getByRole('dialog', { name: '标签页' });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: '新建标签页' }).tap();
    await expect(sheet).toHaveCount(0);
    await title.tap();
    await expect(sheet.getByRole('listitem')).toHaveCount(2);
    await sheet.getByRole('button', { name: `关闭标签 ${noteA.title}` }).tap();
    await expect(sheet.getByRole('listitem')).toHaveCount(1);
    await sheet.getByRole('button', { name: '关闭标签页列表' }).tap();
    await expect(sheet).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    // Pulled down by its grip, the sheet follows the finger and slides away.
    await title.tap();
    await expect(sheet).toBeVisible();
    await page.evaluate(() => {
      const grip = document.querySelector('.mobile-tab-sheet-grip');
      const fire = (type, y) => grip.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: 195, clientY: y }));
      fire('pointerdown', 500);
      for (let step = 1; step <= 10; step++) fire('pointermove', 500 + step * 30);
      fire('pointerup', 800);
    });
    await expect(sheet).toHaveCount(0);
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
  await expect.poll(() => page.locator('.markdown-preview table').count()).toBeGreaterThan(0);
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
  await page.getByRole('dialog', { name: '管理知识库' }).getByRole('menuitem', { name: '知识库设置' }).click();
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

test('account settings shows broker quota and fails closed when the ledger is unavailable', async ({ page }) => {
  const state = defaultState();
  state.model.quota = { limit: 7, used: 4, remaining: 3 };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toHaveText('4 / 7');
  await page.getByRole('button', { name: '关闭设置' }).click();
  await page.route('**/api/account/model', route => json(route, 503, { error: { id: 'quota_unavailable' } }));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
  await expect(dialog.getByRole('status')).toHaveText('暂不可用');
  await expect(dialog.getByRole('alert')).toHaveText('暂时无法读取模型额度，请稍后重试。');
});

test('an exhausted 5h window explains the block and shows both rolling quotas', async ({ page }) => {
  const state = defaultState();
  const resetsAt = new Date(Date.now() + 90 * 60 * 1000).toISOString();
  state.model = {
    configured: false, source: 'product', name: 'deepseek-flash', choices: ['deepseek-flash', 'gpt-6-sol-lite'],
    agent: { sandbox: false, tools: [] }, quota: { limit: 30, used: 30, remaining: 0 },
    windows: [
      { id: '5h', limit: 30, used: 30, remaining: 0, resets_at: resetsAt },
      { id: '7d', limit: 200, used: 41, remaining: 159, resets_at: new Date(Date.now() + 3 * 86400000).toISOString() },
    ],
  };
  await mockWorkspace(page, state);
  await page.route('**/api/sessions/*/messages', route => json(route, 429, { error: { id: 'quota_5h_exceeded' } }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  // The line under the composer says which allowance ran out and when it returns.
  await expect(page.getByRole('button', { name: /^5 小时额度已用完，.+ 恢复$/ })).toBeVisible();
  const chip = page.getByRole('button', { name: '模型：蓝色大肥鱼' });
  await expect(chip).toBeVisible();
  // Quota lives in Settings, not in the model menu.
  await chip.click();
  const menu = page.getByRole('menu', { name: '选择模型' });
  await expect(menu.locator('meter')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('还能继续吗');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('5 小时内的 AI 额度已用完');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toHaveText(['30 / 30', '41 / 200']);
  await expect(dialog).toContainText('5 小时内 AI 额度');
});

test('a CDN timeout keeps waiting for the reply the server saved under the request id', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let sent = null;
  await page.route('**/api/sessions/*/messages', async route => {
    sent = JSON.parse(route.request().postData());
    // The CDN gives up; the server finishes and saves the turn a little later.
    setTimeout(() => {
      const session = state.sessionById[sessionA.id];
      state.sessionById[sessionA.id] = { ...session, messages: [...session.messages,
        { role: 'user', content: sent.content, client_request_id: sent.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
        { role: 'assistant', content: '沙箱已经整理好提纲。', created_at: '2026-01-01T00:00:40.000Z' }] };
    }, 4000);
    await route.fulfill({ status: 504, contentType: 'text/html', body: '<html>Tencent Edgeone</html>' });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('整理提纲');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.getByRole('status', { name: /正在处理/ })).toBeVisible();
  await expect(page.locator('.chat-message.assistant')).toContainText('沙箱已经整理好提纲', { timeout: 15000 });
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: '发送给 Agent 的消息' })).toHaveValue('');
});

test('a reply shows its thinking and each tool call with its own view, and sending is optimistic', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let release;
  const released = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => {
    const sent = JSON.parse(route.request().postData());
    await released;
    const session = state.sessionById[sessionA.id];
    const next = { ...session, messages: [...session.messages,
      { role: 'user', content: sent.content, client_request_id: sent.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '电路笔记讲的是 **KCL**。', created_at: '2026-01-01T00:00:12.000Z', tools: ['read_entry', 'bash'], steps: [
        { kind: 'thinking', text: '先读一下用户的电路笔记' },
        { kind: 'tool', name: 'read_entry', input: '{"id":"n1"}', output: '{"ok":true,"data":{"name":"read_entry","result":{"id":"n1","title":"电路","body":"KCL"}}}' },
        { kind: 'tool', name: 'bash', input: 'ls -la notes', output: 'total 0', failed: false },
        { kind: 'tool', name: 'campus_exams', output: '{"error":"unavailable"}', failed: true },
      ] }] };
    state.sessionById[sessionA.id] = next;
    await json(route, 200, { session: next });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
  await composer.fill('电路笔记讲什么');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  // Optimistic: the message is in the transcript and the composer is clear at once.
  await expect(page.getByRole('article', { name: '正在发送' })).toContainText('电路笔记讲什么');
  await expect(composer).toHaveValue('');
  await expect(page.getByRole('status', { name: /正在处理/ })).toBeVisible();
  release();
  const reply = page.locator('.chat-message.assistant').last();
  await expect(reply).toContainText('电路笔记讲的是');
  const steps = reply.getByRole('list', { name: '思考与工具调用' });
  await expect(steps.getByRole('button', { name: /阅读《电路》/ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /运行命令.*ls -la notes/ })).toBeVisible();
  await expect(steps.getByRole('button', { name: /查询考试安排.*失败/ })).toBeVisible();
  await steps.getByRole('button', { name: /思考过程/ }).click();
  await expect(steps).toContainText('先读一下用户的电路笔记');
  await steps.getByRole('button', { name: /阅读《电路》/ }).click();
  await expect(steps.locator('pre').first()).toContainText('"id": "n1"');
});

test('Agent without a sandbox has no suggestions and shows which tools a reply used', async ({ page }) => {
  const state = defaultState();
  state.model = { ...state.model, agent: { sandbox: false, tools: ['campus_semester', 'campus_timetable', 'search_course_materials'] } };
  await mockWorkspace(page, state);
  await page.route('**/api/sessions/*/messages', async route => {
    const body = route.request().postDataJSON();
    const next = { ...sessionA, messages: [
      { role: 'user', content: body.content, client_request_id: body.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '明天 14:00 以后没有课。', tools: ['campus_semester', 'campus_timetable'], created_at: '2026-01-01T00:00:11.000Z' },
    ] };
    return json(route, 200, { session: next });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('.agent-greeting').or(page.locator('.conversation-row').first())).toBeVisible();
  await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toHaveCount(0);
  const log = page.getByRole('log', { name: '会话记录' });
  // What the Agent can reach is not advertised under the composer.
  await expect(log.getByText('校园服务', { exact: true })).toHaveCount(0);
  await expect(log.getByText('课程资料', { exact: true })).toHaveCount(0);
  await expect(log.locator('.agent-suggested, .agent-starters')).toHaveCount(0);
  await expect(log.getByRole('heading', { name: '建议', exact: true })).toHaveCount(0);
  await page.getByLabel('发送给 Agent 的消息').fill('看看我明天下午什么时候有空');
  await expect(page.getByLabel('发送给 Agent 的消息')).toHaveValue('看看我明天下午什么时候有空');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(log.getByText('明天 14:00 以后没有课。')).toBeVisible();
  const used = log.getByRole('list', { name: '思考与工具调用' });
  await expect(used.getByText('查询学期与教学周')).toBeVisible();
  await expect(used.getByText('读取课表')).toBeVisible();
});

test('Agent replies show original campus images through the API proxy only', async ({ page }) => {
  const state = defaultState();
  state.model = { ...state.model, agent: { sandbox: false, tools: ['search_course_materials', 'read_image'] } };
  await mockWorkspace(page, state);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const proxied = [];
  await page.route('**/api/media/image?**', route => { proxied.push(new URL(route.request().url()).searchParams.get('url')); return route.fulfill({ status: 200, contentType: 'image/png', body: png }); });
  await page.route('**/api/sessions/*/messages', async route => {
    const body = route.request().postDataJSON();
    return json(route, 200, { session: { ...sessionA, messages: [
      { role: 'user', content: body.content, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '帖子原图如下：\n\n![校园卡](https://qnhdpic.twt.edu.cn/download/origin/a.jpg)\n\n![外链](https://evil.example/x.png)\n\n![协议外链](//evil.example/x.png)', tools: ['search_course_materials', 'read_image'], created_at: '2026-01-01T00:00:11.000Z' },
    ] } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByLabel('发送给 Agent 的消息').fill('找一下丢失校园卡的帖子');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const log = page.getByRole('log', { name: '会话记录' });
  const used = log.getByRole('list', { name: '思考与工具调用' });
  await expect(used.getByText('识别图片')).toBeVisible();
  const image = log.getByRole('img', { name: '校园卡' });
  await expect(image).toHaveAttribute('src', '/api/media/image?url=' + encodeURIComponent('https://qnhdpic.twt.edu.cn/download/origin/a.jpg'));
  await expect.poll(() => image.evaluate(img => img.naturalWidth)).toBeGreaterThan(0);
  expect(proxied).toEqual(['https://qnhdpic.twt.edu.cn/download/origin/a.jpg']);
  await expect(log.locator('img[alt="外链"]')).not.toHaveAttribute('src', /evil/);
  await expect(log.locator('img[alt="协议外链"]')).not.toHaveAttribute('src');
});

test('model settings save a custom OpenAI-compatible upstream and switch back', async ({ page }) => {
  const state = defaultState();
  const choices = ['deepseek-flash', 'gpt-6-sol-lite'];
  state.model = { configured: false, source: 'product', name: 'deepseek-flash', choices, quota: { limit: 20, used: 2, remaining: 18 } };
  await mockWorkspace(page, state);
  const puts = [];
  let deletes = 0;
  await page.route('**/api/account/model', async route => {
    const method = route.request().method();
    if (method === 'PUT') {
      const body = route.request().postDataJSON();
      puts.push(body);
      state.model = body.product_model
        ? { configured: false, source: 'product', name: body.product_model, choices, quota: state.model.quota }
        : { configured: true, source: 'custom', name: body.model ?? '', choices, quota: state.model.quota };
    } else if (method === 'DELETE') {
      deletes++;
      state.model = { configured: false, source: 'product', name: 'deepseek-flash', choices, quota: state.model.quota };
      return route.fulfill({ status: 204, body: '' });
    }
    return json(route, 200, { model: state.model });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '模型' }).click();
  const dialog = page.getByRole('dialog');
  const picker = dialog.getByRole('group', { name: 'TJUClaw 模型' });
  await expect(picker.getByRole('button', { name: '蓝色大肥鱼' })).toHaveAttribute('aria-pressed', 'true');
  await picker.getByRole('button', { name: '太阳' }).click();
  await expect(picker.getByRole('button', { name: '太阳' })).toHaveAttribute('aria-pressed', 'true');
  expect(puts).toEqual([{ product_model: 'gpt-6-sol-lite' }]);
  puts.length = 0;
  const save = dialog.getByRole('button', { name: '保存并使用' });
  await expect(save).toBeDisabled();
  await dialog.getByLabel('API 地址').fill('https://api.example.com/v1');
  await dialog.getByLabel('API Key').fill('sk-test-secret');
  await dialog.getByLabel(/模型名/).fill('deepseek-chat');
  await save.click();
  await expect(dialog.getByText('已保存，后续对话将使用你的模型。')).toBeVisible();
  expect(puts).toEqual([{ base_url: 'https://api.example.com/v1', api_key: 'sk-test-secret', model: 'deepseek-chat' }]);
  await expect(dialog.getByLabel('API Key')).toHaveValue('');
  await expect(dialog.getByText('deepseek-chat', { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '改回 TJUClaw 模型' }).click();
  await expect(dialog.getByText('已改回 TJUClaw 提供的模型。')).toBeVisible();
  await expect(picker.getByRole('button', { name: '蓝色大肥鱼' })).toHaveAttribute('aria-pressed', 'true');
  expect(deletes).toBe(1);
});

test('note history lists Git commits of the mirrored note and restores an older version', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  const newer = 'b'.repeat(40), older = 'a'.repeat(40);
  await page.route('**/api/library/git', route => json(route, 200, { git: { enabled: true, state: 'synced', revision: newer, notes: 1 } }));
  await page.route(`**/api/entries/${noteA.id}/history*`, route => {
    const revision = new URL(route.request().url()).searchParams.get('revision');
    if (revision === older) return json(route, 200, { revision, path: 'notes/我的知识库/First note for user A.md', content: '# 旧版本\n\n最初的草稿' });
    if (revision === newer) return json(route, 200, { revision, path: 'notes/我的知识库/First note for user A.md', content: noteA.body });
    return json(route, 200, { path: 'notes/我的知识库/First note for user A.md', commits: [
      { sha: newer, message: 'Sync notes from TJUClaw', author: 'TJUClaw', date: '2026-09-28T10:00:00Z' },
      { sha: older, message: 'Sync notes from TJUClaw', author: 'TJUClaw', date: '2026-09-27T09:00:00Z' },
    ] });
  });
  await page.goto('/workspace');
  await expect(page.locator('.workspace-statusbar')).toContainText(`Git 已同步 · ${newer.slice(0, 7)}`);
  await page.getByRole('button', { name: '版本历史' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('notes/我的知识库/First note for user A.md');
  await expect(dialog.getByText('与当前内容相同')).toBeVisible();
  await dialog.getByRole('button', { name: /Sync notes from TJUClaw · aaaaaaa/ }).click();
  await expect(dialog.locator('.markdown-preview')).toContainText('最初的草稿');
  const saved = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes(`/api/entries/${noteA.id}`));
  await dialog.getByRole('button', { name: '恢复为此版本' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator('.cm-content')).toContainText('最初的草稿');
  expect(JSON.parse((await saved).postData()).body).toBe('# 旧版本\n\n最初的草稿');
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
  await expect(page.getByRole('dialog').getByText('2 篇笔记 · 1 条链接')).toBeVisible();
  await expect(page.locator('.graph-edge')).toHaveCount(1);
  await page.getByRole('button', { name: '打开笔记 Second note' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue('Second note');
});

test('graph reports detail read failures and retries without showing a false empty graph', async ({ page }) => {
  const state = defaultState();
  const second = { ...noteA, id: '33333333333333333333333333333333', title: 'Second note', body: 'Backlink' };
  state.entries = [guideA, noteA, second];
  state.entryById[noteA.id] = { ...noteA, body: '[[Second note]]' };
  state.entryById[second.id] = second;
  await mockWorkspace(page, state);
  let unavailable = true;
  await page.route(`**/api/entries/${second.id}`, route => unavailable
    ? json(route, 503, { error: { id: 'library_storage_unavailable' } })
    : route.fallback());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '知识图谱' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('暂时无法读取笔记链接');
  await expect(page.getByRole('dialog').getByText(/0 条链接/)).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByRole('dialog').getByText('2 篇笔记 · 1 条链接')).toBeVisible();
  await expect(page.locator('.graph-edge')).toHaveCount(1);
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
  // Opening Settings closed the drawer behind it.
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '知识图谱' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '知识图谱' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('conversations are listed on their own and 新对话 starts one without picking an Agent', async ({ page }) => {
  const state = defaultState();
  const old = { ...sessionA, messages: [
    { role: 'user', content: '上次问的电路题', created_at: '2026-01-01T00:00:10.000Z' },
    { role: 'assistant', content: '上次的回答', created_at: '2026-01-01T00:00:11.000Z' },
  ] };
  state.sessionsByEntry[guideA.id] = [old];
  state.sessionById[old.id] = old;
  let created = 0;
  await mockWorkspace(page, state);
  await page.route('**/api/entries/*/sessions', route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const entryId = new URL(route.request().url()).pathname.split('/')[3];
    created += 1;
    const fresh = { id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' + created, entry_id: entryId, created_at: `2026-01-0${created + 1}T00:00:00.000Z`, updated_at: `2026-01-0${created + 1}T00:00:00.000Z` };
    state.sessionsByEntry[entryId] = [fresh, ...(state.sessionsByEntry[entryId] ?? [])];
    state.sessionById[fresh.id] = { ...fresh, messages: [] };
    return json(route, 201, { session: fresh });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const log = page.getByRole('log', { name: '会话记录' });
  const rows = page.locator('.conversation-row');
  // Opening conversations starts a fresh one in a general Agent, not the guide.
  await expect.poll(() => created).toBe(1);
  expect(state.entries.some(entry => entry.kind === 'agent' && entry.title === 'TJUClaw')).toBe(true);
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toHaveText('新对话');
  await expect(page.getByRole('button', { name: '新手向导' })).toHaveCount(0);
  // An empty conversation is reused rather than piling up new ones.
  await page.getByLabel('工作区工具').getByRole('button', { name: '新对话' }).click();
  await page.waitForTimeout(500);
  expect(created).toBe(1);
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('新的问题');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(log).toContainText('已收到');
  await expect(rows.first()).toHaveText('新的问题');
  await rows.filter({ hasText: '上次问的电路题' }).click();
  await expect(log).toContainText('上次的回答');
  await expect(log).not.toContainText('新的问题');
  await page.getByRole('button', { name: '新会话', exact: true }).click();
  await expect.poll(() => created).toBe(2);
  await expect(log).not.toContainText('上次的回答');
  await expect(rows).toHaveCount(3);
});

test('the outline tab follows reading and jumps to the exact heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = defaultState();
  const body = '# 概览\n\n' + '引言段落。\n\n'.repeat(40) + '## 概览\n\n' + '正文。\n\n'.repeat(40) + '```\n# 代码里的注释\n```\n\n## 结论\n\n收尾。';
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  // Like Typora, the sidebar switches between the files and the outline.
  await page.getByRole('tab', { name: '大纲' }).click();
  const outline = page.getByRole('navigation', { name: '笔记大纲' });
  // Fenced code is not a heading.
  await expect(outline.locator('.outline-item')).toHaveText(['概览', '概览', '结论']);
  await expect(outline.locator('.outline-row.is-active')).toHaveText('概览');
  // Jumps to the second 概览 (not the first match of its text) without moving the caret.
  await outline.locator('.outline-item').nth(1).click();
  await expect(outline.locator('.outline-row').nth(1)).toHaveClass(/is-active/);
  await expect(page.locator('.cm-md-heading-line-2').first()).toBeInViewport();
  await outline.getByRole('button', { name: '结论', exact: true }).click();
  // Let both delayed height corrections run: an older jump must not steal
  // the scroll position/highlight from the most recent outline click.
  await page.waitForTimeout(1000);
  await expect(outline.locator('.outline-row').nth(2)).toHaveClass(/is-active/);
  await expect(page.locator('.cm-md-heading-line').filter({ hasText: '结论' })).toBeInViewport();
  // Collapsing a section hides its children.
  await outline.getByRole('button', { name: '折叠 概览' }).click();
  await expect(outline.locator('.outline-item')).toHaveText(['概览']);
  // The chosen tab is remembered.
  await page.reload();
  await expect(page.getByRole('tab', { name: '大纲' })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: '文件' }).click();
});

test('each campus account is bound on its own and only the tools that need it ask for it', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  let captchas = 0;
  await page.route('**/api/campus/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/campus/session' && route.request().method() === 'POST') return json(route, 200, { user_number: '3020999999', nickname: '同学', expires_at: '2099-01-01T00:00:00Z' });
    if (path === '/api/campus/office/captcha') { captchas++; return json(route, 200, { captcha_id: 'c1', content_type: 'image/png', data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z' }); }
    return json(route, 204, {});
  });
  await page.goto('/workspace');
  await openCampusTools(page);
  // Tools without an account need nothing.
  await page.locator('.campus-sidebar-list').getByRole('button', { name: '校园地图' }).click();
  await expect(page.getByRole('region', { name: '校园账号' })).toHaveCount(0);
  await page.locator('.campus-sidebar-list').getByRole('button', { name: '入校码' }).click();
  await expect(page.getByRole('region', { name: '校园账号' })).toContainText('微北洋');
  // Only 微北洋: the entry code is ready, the timetable still asks for 办公网, and no captcha appears.
  await bindCampusAccounts(page, { wpy: ['campus-user', 'campus-password'] });
  await expect(page.getByRole('region', { name: '校园账号' })).toHaveCount(0);
  await page.locator('.campus-sidebar-list').getByRole('button', { name: '课程表' }).click();
  await expect(page.getByRole('region', { name: '校园账号' })).toContainText('办公网账号，当前没有绑定');
  await expect(page.getByRole('img', { name: '办公网验证码' })).toHaveCount(0);
  expect(captchas).toBe(0);
});

test('the composer sends the chosen thinking strength', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const effort = page.getByRole('button', { name: /^思考强度：/ });
  await expect(effort).toHaveAccessibleName('思考强度：自动');
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('默认');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => state.sentRequests.length).toBe(1);
  expect(state.sentRequests[0].effort).toBeUndefined();
  await effort.click();
  await page.getByRole('menu', { name: '思考强度' }).getByRole('menuitemradio', { name: /深入/ }).click();
  await expect(effort).toHaveAccessibleName('思考强度：深入');
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('深入');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect.poll(() => state.sentRequests.length).toBe(2);
  expect(state.sentRequests[1].effort).toBe('high');
  await page.reload();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.getByRole('button', { name: '思考强度：深入' })).toBeVisible();
});

test('live preview draws rules, inline HTML, math, footnotes, images and quoted blocks', async ({ page }) => {
  const state = defaultState();
  const body = [
    '标题一', '======', '', '---', '',
    '<mark>高亮</mark> 与 H<sub>2</sub>O 与 <kbd>Ctrl</kbd>', '',
    '行内 $E = mc^2$ 公式', '', '$$', '\\sum_{i=1}^{n} i', '$$', '',
    '脚注句子。[^1]', '', '[^1]: 脚注内容。', '',
    '[![可点击](https://picsum.photos/300/120)](https://example.com)', '',
    '<https://example.com>', '', '\\*不是斜体\\*', '',
    '> 外层', '>', '>> 内层', '', '> ```js', '> const a = 1;', '> ```', '',
    '> | A | B |', '> |---|---|', '> | 1 | 2 |', '', '<details>', '<summary>展开</summary>', '', '内容', '', '</details>',
  ].join('\n');
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor');
  await expect(editor.locator('.cm-md-hr-line')).toHaveCount(1);
  await expect(editor).not.toContainText('======');
  await expect(editor.locator('.cm-md-html-mark')).toHaveText('高亮');
  await expect(editor.locator('.cm-md-html-kbd')).toHaveText('Ctrl');
  await expect(editor).not.toContainText('<mark>');
  await expect(editor.locator('.cm-md-math math')).toHaveCount(2);
  await expect(editor.locator('.cm-md-math-block')).toHaveCount(1);
  await expect(editor.locator('.cm-md-footnote-ref')).toHaveText('1');
  await expect(editor.locator('.cm-md-footnote-label')).toHaveText('1.');
  // External HTTPS images load in notes (the test page cannot reach the network, so the card may show instead).
  await expect(editor.locator('.cm-md-image, .cm-md-image-card')).toHaveCount(1);
  await expect(editor).not.toContainText('<https://');
  await expect(editor).toContainText('*不是斜体*');
  await expect(editor.locator('.cm-md-quote-d2')).toHaveCount(1);
  await expect(editor.locator('.cm-md-code-label')).toHaveText('js');
  await expect(editor.locator('.cm-md-table th')).toHaveText(['A', 'B']);
  await expect(editor.locator('.cm-md-summary')).toHaveText('展开');
  await expect(editor).not.toContainText('<details>');
});

test('search finds notes by title and full text, and runs quick actions', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let searched = '';
  await page.route('**/api/libraries/*/search?**', route => {
    searched = new URL(route.request().url()).searchParams.get('q') ?? '';
    return json(route, 200, { hits: searched === '电流' ? [{ id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee7', title: '电路复习', snippet: '基尔霍夫电流定律', source: 'note' }] : [] });
  });
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  await expect(page.locator('.obsidian-search')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog');
  const input = palette.getByRole('textbox', { name: '搜索' });
  await expect(input).toBeFocused();
  await expect(palette.getByRole('region', { name: '笔记' })).toContainText('First note for user A');
  await input.fill('电流');
  await expect.poll(() => searched).toBe('电流');
  const fullText = palette.getByRole('region', { name: '全文' });
  await expect(fullText.getByRole('option')).toHaveCount(1);
  await expect(fullText.locator('mark')).toHaveText('电流');
  await expect(palette.getByRole('option', { name: /新建笔记「电流」/ })).toBeVisible();
  await input.fill('');
  await input.fill('First');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
});

test('a running turn shows thinking, words and every tool call in order, and the saved reply takes its place without a jump', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  // The timeline as the server holds it at each moment of the turn.
  const said = '我先把笔记写好，再改一处。';
  const moments = [
    { stage: 'preparing', items: [
      { kind: 'thinking', text: '先想想怎么整理' },
      { kind: 'text', text: said },
      { kind: 'tool', name: 'write', input: '{"path":"notes/电路.md"}', status: 'writing', lines: 40 }] },
    { stage: 'tool', items: [
      { kind: 'thinking', text: '先想想怎么整理' },
      { kind: 'text', text: said },
      { kind: 'tool', name: 'write', input: '{"path":"notes/电路.md"}', status: 'running', added: 48 },
      { kind: 'tool', name: 'edit', input: '{"path":"notes/a.md"}', status: 'running', added: 2, removed: 1 },
      { kind: 'tool', name: 'read', input: '{"path":"figures/波形.png"}', status: 'running' },
      { kind: 'tool', name: 'update_entry', input: '{"id":"n1","title":"电路"}', status: 'running' },
      { kind: 'tool', name: 'campus_exams', input: '{}', status: 'running' }] },
    { stage: 'writing', items: [
      { kind: 'thinking', text: '先想想怎么整理' },
      { kind: 'text', text: said },
      { kind: 'tool', name: 'write', input: '{"path":"notes/电路.md"}', status: 'done', added: 48, output: 'Successfully wrote' },
      { kind: 'tool', name: 'edit', input: '{"path":"notes/a.md"}', status: 'done', added: 2, removed: 1 },
      { kind: 'tool', name: 'read', input: '{"path":"figures/波形.png"}', status: 'done' },
      // A note written through the knowledge-base tool is counted in characters.
      { kind: 'tool', name: 'update_entry', input: '{"id":"n1","title":"电路"}', status: 'done', added: 320, removed: 45, unit: 'char' },
      { kind: 'tool', name: 'campus_exams', input: '{}', status: 'failed' },
      { kind: 'thinking', text: '都处理完了' },
      { kind: 'text', text: '笔记已经**整理好**。' }] },
  ];
  let moment = 0;
  const seen = [];
  await page.route('**/api/sessions/*/live*', async route => {
    const query = new URL(route.request().url()).searchParams;
    // A client that already has this moment waits, as the long poll does.
    for (let waited = 0; Number(query.get('version')) === moment + 1 && waited < 100; waited++) await new Promise(resolve => setTimeout(resolve, 50));
    seen.push(query.toString());
    const now = moments[moment];
    return json(route, 200, { version: moment + 1, count: now.items.length, stage: { id: now.stage, ms: 0 }, rate: { tokens: 120, ms: 2000 },
      items: now.items.map((item, i) => ({ i, next: new TextEncoder().encode(item.text ?? '').length, ...item })) });
  });
  const steps = [
    { kind: 'thinking', text: '先想想怎么整理' },
    // Saved as a thinking step marked as said, so clients released earlier still read the reply.
    { kind: 'thinking', said: true, text: said },
    { kind: 'tool', name: 'write', input: '{"path":"notes/电路.md"}', output: 'Successfully wrote to notes/电路.md', added: 48 },
    { kind: 'tool', name: 'edit', input: '{"path":"notes/a.md"}', output: ' 1 line one\n-2 line two\n+2 line 2\n+3 line 2b\n 3 line three', added: 2, removed: 1 },
    { kind: 'tool', name: 'read', input: '{"path":"figures/波形.png"}', output: 'Read image file [image/png]' },
    { kind: 'tool', name: 'update_entry', input: '{"id":"n1","title":"电路"}', output: '{"id":"n1","title":"电路"}', added: 320, removed: 45, unit: 'char' },
    { kind: 'tool', name: 'campus_exams', input: '{}', output: '{"ok":false}', failed: true },
    { kind: 'thinking', text: '都处理完了' },
  ];
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => {
    const sent = JSON.parse(route.request().postData());
    await held;
    const session = state.sessionById[sessionA.id];
    const next = { ...session, messages: [...session.messages,
      { role: 'user', content: sent.content, client_request_id: sent.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '笔记已经**整理好**。', created_at: '2026-01-01T00:00:40.000Z', steps }] };
    state.sessionById[sessionA.id] = next;
    return json(route, 200, next);
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('整理电路笔记');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const working = page.getByRole('status', { name: /正在处理/ });

  // While the file is written: the thought folded, the words said, and the write counting its lines.
  await expect(working.getByRole('button', { name: /思考过程/ })).toHaveCount(1);
  await expect(working.locator('.agent-step-said')).toHaveText(said);
  const write = working.getByRole('button', { name: /写入文件/ });
  await expect(write).toContainText('电路.md');
  await expect(write.getByRole('img', { name: '已写入 40 行' })).toBeVisible();
  await expect(write.getByRole('img', { name: '进行中' })).toBeVisible();
  await expect(working.locator('.agent-working-text')).toHaveText('正在准备写入文件');
  await expect(working.locator('.agent-working-rate')).toHaveText('60 token/秒');

  // The calls run: the write and the edit say what they change, the image read is named as one.
  moment = 1;
  await expect(write.getByRole('img', { name: '新增 48 行' })).toBeVisible();
  await expect(working.getByRole('button', { name: /编辑文件/ }).getByRole('img', { name: '新增 2 行，删除 1 行' })).toBeVisible();
  await expect(working.getByRole('button', { name: /查看图片/ })).toContainText('波形.png');
  await expect(working.getByRole('img', { name: '进行中' })).toHaveCount(5);
  // A tool run has no writing speed.
  await expect(working.locator('.agent-working-rate')).toHaveCount(0);

  // The results arrive with the next model call, then the reply is written.
  moment = 2;
  await expect(working.getByRole('img', { name: '已完成' })).toHaveCount(4);
  await expect(working.getByRole('button', { name: /修改《电路》/ }).getByRole('img', { name: '新增 320 字，删除 45 字' })).toBeVisible();
  await expect(working.getByRole('button', { name: /查询考试安排.*失败/ })).toBeVisible();
  await expect(working.getByRole('button', { name: /思考过程/ })).toHaveCount(2);
  await expect(working.locator('.agent-live-text strong')).toHaveText('整理好');
  // Earlier rows were never taken back, and only changed rows were asked for again.
  await expect(working.locator('.agent-step-said')).toHaveText(said);
  expect(seen[0]).toBe('');
  expect(seen.some(query => /^version=\d+&tail=\d+&at=\d+$/.test(query))).toBe(true);

  const before = await working.locator('.agent-step, .agent-step-said, .agent-live-text').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
  release();
  await expect(working).toHaveCount(0);
  // The saved reply: the same rows in the same places, unfolded although it has many tool calls.
  const reply = page.locator('.chat-message.assistant').last();
  await expect(reply).toHaveClass(/is-watched/);
  await expect(reply.locator('.agent-step.is-more')).toHaveCount(0);
  const after = await reply.locator('.agent-step, .agent-step-said, .agent-reply-body > .chat-message-content').evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().top)));
  expect(after.length).toBe(before.length);
  after.forEach((top, index) => expect(Math.abs(top - before[index]), `row ${index}`).toBeLessThanOrEqual(3));
  await expect(reply.getByRole('button', { name: /修改《电路》/ }).getByRole('img', { name: '新增 320 字，删除 45 字' })).toBeVisible();
  await expect(reply.getByRole('button', { name: /写入文件/ }).getByRole('img', { name: '新增 48 行' })).toHaveText('+48 行');
  // The edit opens to what it changed.
  await reply.getByRole('button', { name: /编辑文件/ }).click();
  await expect(reply.locator('.agent-step-diff-line.is-added')).toHaveCount(2);
  await expect(reply.locator('.agent-step-diff-line.is-removed')).toHaveText('-2 line two');
});

test('settings show the running version and build, and explain updates where none can be checked', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '关于', exact: true }).click();
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  await expect(dialog.locator('.settings-value').first()).toHaveText(new RegExp(`^v${version.replaceAll('.', '\\.')}( · [0-9a-f]{7})?$`));
  // This suite blocks service workers, as a browser without them would.
  await dialog.getByRole('button', { name: '检查更新', exact: true }).click();
  await expect(dialog.getByText('当前环境无法检查更新，刷新页面即可获取最新版本。')).toBeVisible();
});

test('a cached workspace paints before the cloud answers, including on a phone session menu', async ({ page }) => {
  const state = defaultState();
  state.entries = [guideA, noteA, noteC];
  state.entryById = Object.fromEntries(state.entries.map(item => [item.id, { ...item }]));
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);
  await page.getByRole('button', { name: noteC.title, exact: true }).click();
  await expect(page.locator('.cm-content')).toContainText('Another document');
  let release = () => {};
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/libraries/**', async route => { await held; return route.fallback(); });
  await page.route('**/api/vault/status', async route => { await held; return route.fallback(); });
  await page.route('**/api/decks**', async route => { await held; return route.fallback(); });
  try {
    await page.reload();
    await expect(page.locator('.note-title')).toHaveValue(noteC.title, { timeout: 2500 });
    await expect(page.locator('.workspace-opening')).toHaveCount(0);
    await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
    await page.getByRole('button', { name: '主页', exact: true }).click();
    await expect(page.locator('.notion-home')).toBeVisible();
    await expect(page.locator('.workspace-opening')).toHaveCount(0);
    await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
    await page.getByRole('button', { name: noteC.title, exact: true }).click();
    await expect(page.locator('.note-title')).toHaveValue(noteC.title);
    await expect(page.locator('.cm-content')).toContainText('Another document');
    await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
  } finally {
    release();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  const opener = page.locator('.sidebar-opener');
  if ((await opener.getAttribute('aria-label')) === '打开侧栏') await opener.click();
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '工作', exact: true }).click();
  // The drawer's head holds the library and the collapse button only; conversation actions live in the top bar.
  await expect(page.locator('.notion-side-head').getByRole('button')).toHaveCount(2);
  await expect(page.locator('.obsidian-sidebar').getByRole('button', { name: '会话操作' })).toHaveCount(0);
  await page.getByRole('button', { name: '收起侧栏' }).first().click();
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
  const more = page.getByRole('button', { name: '会话操作', exact: true });
  await expect(more).toBeVisible();
  const box = await more.boundingBox();
  expect(box).toBeTruthy();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  const hit = await more.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const target = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
    return Boolean(target && (target === element || element.contains(target)));
  });
  expect(hit).toBe(true);
  await more.click();
  const menu = page.getByRole('menu', { name: '会话操作' });
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '新会话' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '历史会话' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: '压缩上下文' })).toHaveCount(0);
});

test('a note already on this device opens without waiting, and a newer server copy replaces it only if untouched', async ({ page }) => {
  const state = defaultState();
  state.entries = [guideA, noteA, noteC];
  state.entryById = Object.fromEntries(state.entries.map(item => [item.id, { ...item }]));
  await mockWorkspace(page, state);
  // The server's copy of the note; `listed` also changes what the tree reports.
  const revise = (patch, listed = false) => {
    state.entryById[noteC.id] = { ...state.entryById[noteC.id], ...patch };
    if (listed) state.entries = state.entries.map(item => item.id === noteC.id ? state.entryById[noteC.id] : item);
  };
  // A held body read proves that what is on screen meanwhile came from the device.
  let hold = false, release, reads = 0;
  let gate = Promise.resolve();
  const block = () => { hold = true; gate = new Promise(resolve => { release = () => { hold = false; resolve(); }; }); };
  await page.route(`**/api/entries/${noteC.id}`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    reads += 1;
    if (hold) await gate;
    return route.fallback();
  });
  const open = () => page.getByRole('button', { name: noteC.title, exact: true }).click();
  const editor = page.locator('.cm-content');
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);

  // First open: fetched from the server and kept on the device.
  await open();
  await expect(editor).toContainText('Another document');
  expect(reads).toBe(1);
  // The database opens with the first note opened by hand; give the write a moment to land.
  await expect.poll(() => page.evaluate(() => navigator.storage.getDirectory()
    .then(root => root.getDirectoryHandle('.tjuclaw-sqlite')).then(() => true, () => false))).toBe(true);
  await page.waitForTimeout(400);

  // After a reload the last note is painted from this device before the cloud
  // answers, and a matching revision is not fetched again.
  await page.reload();
  await expect(page.locator('.note-title')).toHaveValue(noteC.title);
  await expect(editor).toContainText('Another document');
  await expect(page.locator('.workspace-opening')).toHaveCount(0);
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
  await page.waitForTimeout(400);
  expect(reads).toBe(1);

  // A different listed revision is fetched in the background. Untouched text takes the new body.
  revise({ updated_at: '2026-02-02T00:00:00.000Z' }, true);
  block();
  await page.reload();
  await expect(page.locator('.note-title')).toHaveValue(noteC.title);
  await expect(editor).toContainText('Another document');
  await expect.poll(() => reads).toBe(2);
  revise({ body: '另一台设备写入的新内容', updated_at: '2026-02-02T00:00:00.000Z' });
  release();
  await expect(editor).toContainText('另一台设备写入的新内容');

  // A note being edited keeps the reader's text when a newer revision arrives.
  revise({ updated_at: '2026-03-03T00:00:00.000Z' }, true);
  block();
  await page.reload();
  await expect(page.locator('.note-title')).toHaveValue(noteC.title);
  await expect(editor).toContainText('另一台设备写入的新内容');
  await editor.click();
  await page.keyboard.type('我正在写');
  revise({ body: '第三个版本', updated_at: '2026-03-03T00:00:00.000Z' });
  release();
  await expect.poll(() => reads).toBe(3);
  await expect(editor).toContainText('我正在写');
  await expect(editor).not.toContainText('第三个版本');
});

test('a running turn writes the model\'s thinking and reply as they arrive, and typing warms the sandbox once', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let prepared = 0;
  await page.route('**/api/sessions/*/prepare', route => { prepared += 1; return route.fulfill({ status: 202 }); });
  // Each answer is what a client with that cursor has not seen yet; offsets are bytes.
  // Each answer is what a client with that cursor has not seen yet; offsets are bytes.
  const frame = (version, count, stage, item) => ({ version, count, stage: { id: stage, ms: 0 }, rate: { tokens: 30, ms: 1000 }, items: [item] });
  const cursors = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/sessions/*/live*', async route => {
    const query = new URL(route.request().url()).searchParams;
    cursors.push(query.toString());
    if (!query.has('version')) return json(route, 200, frame(1, 1, 'thinking', { i: 0, kind: 'thinking', text: '先分析', next: 9 }));
    if (query.get('version') === '1') return json(route, 200, frame(2, 1, 'thinking', { i: 0, kind: 'thinking', text: '题目', from: 9, next: 15 }));
    if (query.get('version') === '2') return json(route, 200, frame(3, 2, 'writing', { i: 1, kind: 'text', text: '**基尔霍夫**', next: 16 }));
    if (query.get('version') === '3') return json(route, 200, frame(4, 2, 'writing', { i: 1, kind: 'text', text: '定律', from: 16, next: 22 }));
    // Nothing new: the server holds the request until the turn changes.
    await finished;
    return json(route, 200, { version: 0, count: 0, items: [], stage: { id: '', ms: 0 }, rate: { tokens: 0, ms: 0 } });
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => { await held; return route.fallback(); });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
  await composer.fill('什么是');
  await composer.fill('什么是基尔霍夫定律');
  await expect.poll(() => prepared).toBe(1);
  await page.getByRole('button', { name: '发送', exact: true }).click();

  const working = page.getByRole('status', { name: /正在处理/ });
  const reply = working.locator('.agent-live-text');
  await expect(reply).toHaveText('基尔霍夫定律');
  await expect(reply.locator('strong')).toHaveText('基尔霍夫');
  await expect(working.locator('.agent-working-text')).toHaveText('正在回答');
  await expect(working.locator('.agent-working-rate')).toContainText('token/秒');
  // Once the reply starts, the thinking folds into a row that still opens.
  await expect(working.getByLabel('思考过程')).toHaveCount(0);
  await working.getByRole('button', { name: /思考过程/ }).click();
  await expect(working.locator('.agent-step-thought')).toHaveText('先分析题目');
  expect(cursors.slice(0, 4)).toEqual(['', 'version=1&tail=0&at=9', 'version=2&tail=0&at=15', 'version=3&tail=1&at=16']);

  finish();
  // The turn ending clears the live snapshot. The reply already on screen stays
  // until the confirmed message replaces this working view.
  await expect(reply).toHaveText('基尔霍夫定律');
  release();
  await expect(working).toHaveCount(0);
  await expect(page.locator('.chat-message.assistant').last()).toBeVisible();
  expect(prepared).toBe(1);
});

test('a running turn shows the thinking alone until the reply begins', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.route('**/api/sessions/*/prepare', route => route.fulfill({ status: 202 }));
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/sessions/*/live*', async route => {
    const versioned = new URL(route.request().url()).searchParams.has('version');
    if (versioned) await finished;
    return json(route, 200, versioned ? { version: 0, count: 0, items: [], stage: { id: '', ms: 0 }, rate: { tokens: 0, ms: 0 } }
      : { version: 1, count: 2, stage: { id: 'thinking', ms: 0 }, rate: { tokens: 12, ms: 300 }, items: [
        { i: 0, kind: 'tool', name: 'campus_timetable', status: 'done' },
        { i: 1, kind: 'thinking', text: '先看看课表里今天有什么课', next: 36 }] });
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => { await held; return route.fallback(); });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('今天有什么课');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const working = page.getByRole('status', { name: /正在处理/ });
  await expect(working.getByLabel('思考过程')).toHaveText('先看看课表里今天有什么课');
  await expect(working.locator('.agent-working-text')).toHaveText('模型正在思考');
  // The finished tool call and the thought being written are two rows of one list.
  await expect(working.getByRole('list', { name: '正在进行的步骤' }).getByRole('listitem')).toHaveCount(2);
  await expect(working.locator('.agent-live-text')).toHaveCount(0);
  finish();
  release();
  await expect(working).toHaveCount(0);
});

test('replies highlight code, offer a copy button and draw no external images', async ({ page }) => {
  const state = defaultState();
  state.sessionById[sessionA.id] = { ...sessionA, messages: [
    { role: 'user', content: '代码', created_at: '2026-01-01T00:00:10.000Z' },
    { role: 'assistant', content: '```python\ndef add(a, b):\n    return a + b  # 相加\n```', created_at: '2026-01-01T00:00:11.000Z' },
  ] };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.locator('.conversation-row').filter({ hasText: '代码' }).click();
  const block = page.locator('.chat-message.assistant .code-block');
  await expect(block.locator('.code-block-head span')).toHaveText('python');
  await expect(block.locator('.tok-keyword').first()).toHaveText('def');
  await expect(block.locator('.tok-comment')).toContainText('相加');
  await page.evaluate(() => { let copied = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { copied = text; window.__copied = copied; } } }); });
  await block.hover();
  await block.getByRole('button', { name: '复制代码' }).click();
  await expect.poll(() => page.evaluate(() => window.__copied)).toContain('def add(a, b):');
});


test('reading mode scrolls as one page, keeps wide blocks whole and remembers the position', async ({ page }) => {
  const state = defaultState();
  const wideRow = '| ' + Array.from({ length: 14 }, (_, index) => `第 ${index + 1} 列的一段比较长的内容`).join(' | ') + ' |';
  const body = [
    '# 开头',
    ...Array.from({ length: 30 }, (_, index) => `第 ${index + 1} 段：春眠不觉晓，处处闻啼鸟。夜来风雨声，花落知多少。`),
    '## 表格',
    [wideRow, '| ' + Array.from({ length: 14 }, () => '---').join(' | ') + ' |', wideRow].join('\n'),
    '```js\nconst veryLongLine = "' + 'x'.repeat(400) + '";\n```',
    ...Array.from({ length: 30 }, (_, index) => `后 ${index + 1} 段：白日依山尽，黄河入海流。欲穷千里目，更上一层楼。`),
    '## 结尾',
    '收尾。',
  ].join('\n\n');
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '阅读模式' }).click();
  const reader = page.getByRole('region', { name: '阅读' });
  await expect(reader).toBeVisible();
  // One continuous page: no page counter, no page-turn buttons.
  await expect(page.locator('.paged-reader-count')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '下一页' })).toHaveCount(0);
  const scroller = page.locator('.note-editor');
  const metrics = () => scroller.evaluate(node => ({ top: node.scrollTop, range: node.scrollHeight - node.clientHeight, overflowX: node.scrollWidth - node.clientWidth }));
  const start = await metrics();
  expect(start.range).toBeGreaterThan(600);
  // The page itself never scrolls sideways.
  expect(start.overflowX).toBeLessThanOrEqual(1);
  // A wide table and a long code line stay whole and scroll inside their own box.
  // Measured from the document each time: the preview may be redrawn once the note finishes loading.
  for (const selector of ['table', 'pre']) {
    await expect.poll(() => page.evaluate(selector => {
      const node = document.querySelector(`.note-reader ${selector}`);
      const editor = node?.closest('.note-editor');
      if (!node || !editor) return null;
      const rect = node.getBoundingClientRect();
      const page = editor.getBoundingClientRect();
      return {
        inside: rect.left >= page.left - 1 && rect.right <= page.right + 1,
        // The long code line cannot wrap, so its box scrolls; the table may wrap its cells to fit.
        scrolls: selector === 'pre' ? node.scrollWidth > node.clientWidth : true,
        columns: getComputedStyle(node.closest('.markdown-preview')).columnCount,
      };
    }, selector), selector).toEqual({ inside: true, scrolls: true, columns: 'auto' });
  }
  // Every cell of the wide row is there, none cut off at a page edge.
  await expect(reader.locator('table tr').first().locator('th, td')).toHaveCount(14);
  // Scrolling moves through the note, and the position survives a reload.
  await reader.getByRole('heading', { name: '结尾' }).scrollIntoViewIfNeeded();
  await expect(reader.getByRole('heading', { name: '结尾' })).toBeInViewport();
  const moved = await metrics();
  expect(moved.top).toBeGreaterThan(400);
  await expect.poll(() => page.evaluate(id => JSON.parse(localStorage.getItem(`tjuclaw.reader.v1.${id}`) ?? '{}').fraction ?? 0, noteA.id)).toBeGreaterThan(0.5);
  await page.reload();
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.getByRole('region', { name: '阅读' }).getByRole('heading', { name: '结尾' })).toBeInViewport();
  // On a phone the same table is wider than the page: it scrolls in its own box and the page does not.
  await page.setViewportSize({ width: 390, height: 844 });
  if (!(await page.locator('.note-reader').count())) await page.getByRole('button', { name: '阅读模式' }).click();
  await expect.poll(() => page.evaluate(() => {
    const node = document.querySelector('.note-reader table');
    const editor = node?.closest('.note-editor');
    if (!node || !editor) return null;
    return { inside: node.getBoundingClientRect().right <= editor.getBoundingClientRect().right + 1, scrolls: node.scrollWidth > node.clientWidth, pageOverflow: editor.scrollWidth - editor.clientWidth };
  })).toEqual({ inside: true, scrolls: true, pageOverflow: 0 });
});

test('in reading mode the outline follows the scroll and jumps to a heading', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const state = defaultState();
  const body = '# 概览\n\n' + '引言段落。\n\n'.repeat(40) + '## 中段\n\n' + '正文。\n\n'.repeat(40) + '## 结论\n\n' + '收尾。\n\n'.repeat(40);
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body } : entry);
  state.entryById[noteA.id] = { ...state.entryById[noteA.id], body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '阅读模式' }).click();
  await page.getByRole('tab', { name: '大纲' }).click();
  const outline = page.getByRole('navigation', { name: '笔记大纲' });
  const reader = page.getByRole('region', { name: '阅读' });
  await expect(outline.locator('.outline-row.is-active')).toHaveText('概览');
  await outline.getByRole('button', { name: '结论', exact: true }).click();
  await expect(reader.getByRole('heading', { name: '结论' })).toBeInViewport();
  await expect(outline.locator('.outline-row.is-active')).toHaveText('结论');
  // Scrolling back up moves the outline with it.
  await reader.getByRole('heading', { name: '中段' }).evaluate(node => node.scrollIntoView({ block: 'start' }));
  await expect(outline.locator('.outline-row.is-active')).toHaveText('中段');
  await page.getByRole('tab', { name: '文件' }).click();
});

test('EPUB books open in the paged reader with their chapters', async ({ page }) => {
  const state = defaultState();
  const chapter = (title, body) => strToU8(`<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><head><title>${title}</title></head><body><h1>${title}</h1>${body}</body></html>`);
  const epub = Buffer.from(zipSync({
    mimetype: strToU8('application/epub+zip'),
    'META-INF/container.xml': strToU8('<?xml version="1.0"?><container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/book.opf"/></rootfiles></container>'),
    'OEBPS/book.opf': strToU8('<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>测试之书</dc:title><dc:creator>佚名</dc:creator></metadata><manifest><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/><item id="a" href="a.xhtml" media-type="application/xhtml+xml"/><item id="b" href="b.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="a"/><itemref idref="b"/></spine></package>'),
    'OEBPS/nav.xhtml': strToU8('<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol><li><a href="a.xhtml">开端</a></li><li><a href="b.xhtml">尾声</a></li></ol></nav></body></html>'),
    'OEBPS/a.xhtml': chapter('开端', '<p>第一章正文。<script>window.__evil = 1</script></p><p><a href="b.xhtml">去尾声</a></p>'),
    'OEBPS/b.xhtml': chapter('尾声', '<p>全书完。</p>'),
  }));
  const book = { ...noteA, id: '99999999999999999999999999999998', kind: 'file', title: '测试之书.epub', content_type: 'application/epub+zip', size: epub.length, body: undefined };
  state.entries.push(book);
  state.entryById[book.id] = book;
  await mockWorkspace(page, state);
  await page.route(`**/api/entries/${book.id}/file`, route => route.fulfill({ status: 200, contentType: 'application/epub+zip', body: epub }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '测试之书.epub' }).click();
  const reader = page.getByRole('region', { name: '阅读' });
  await expect(reader.locator('.epub-reader-head')).toContainText('测试之书');
  await expect(reader).toContainText('第一章正文。');
  expect(await page.evaluate(() => window.__evil)).toBeUndefined();
  await reader.getByRole('button', { name: '目录' }).click();
  await expect(reader.getByRole('list', { name: '章节' }).getByRole('button')).toHaveText(['开端', '尾声']);
  await reader.getByRole('button', { name: '目录' }).click();
  // A link to another chapter turns there; at the end of a chapter the next one begins.
  await reader.getByRole('link', { name: '去尾声' }).click();
  await expect(reader).toContainText('全书完。');
  await page.keyboard.press('ArrowLeft');
  await expect(reader).toContainText('第一章正文。');
  await page.keyboard.press('ArrowRight');
  await expect(reader).toContainText('全书完。');
});

test('new note home opens a confirmed empty note without fetching its omitted body', async ({ page }) => {
  const state = defaultState();
  state.entries = [guideA];
  await mockWorkspace(page, state);
  await page.route(`**/api/libraries/${libA.id}/entries`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    state.entries.push(createdNote);
    state.entryById[createdNote.id] = { ...createdNote };
    return json(route, 201, { entry: createdNote });
  });
  await page.route(`**/api/entries/${createdNote.id}`, route => json(route, 503, { error: { id: 'unavailable' } }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '空白笔记', exact: true }).click();
  await expect(page.locator('.note-editor')).toBeVisible();
  await expect(page.locator('.note-title')).toHaveValue('未命名笔记');
});

test('slow note creation shows feedback, prevents duplicates and then opens the editor', async ({ page }) => {
  const state = defaultState();
  state.entries = [guideA];
  let release;
  state.holdCreate = new Promise(resolve => { release = resolve; });
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '空白笔记', exact: true }).click();
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toContainText('正在创建笔记');
  await expect(page.getByRole('button', { name: '空白笔记', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '切换大纲', exact: true })).toHaveCount(0);
  release();
  await expect(page.locator('.note-editor')).toBeVisible();
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
});

test('multiline display math stays one editable formula across blank lines and adjacent prose', async ({ page }) => {
  const state = defaultState();
  const body = '# 公式\n\n$$\n\\begin{aligned}\nx &= 1 \\\\\n\ny &= 2\n\\end{aligned}\n$$\n公式后的正文\n\n> $$\n> \\begin{cases}\n> a & x > 0 \\\\\n> b & x \\le 0\n> \\end{cases}\n> $$\n\n```tex\n$$\nz=3\n$$\n```';
  state.entryById[noteA.id] = { ...noteA, body };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const editor = page.locator('.codemirror-editor');
  await expect(editor.locator('.cm-md-math-block math')).toHaveCount(2);
  await expect(editor.locator('.katex-error')).toHaveCount(0);
  await expect(editor).toContainText('公式后的正文');
  await editor.locator('.cm-md-math-block').first().click();
  await expect(editor.locator('.cm-content')).toContainText('\\begin{aligned}');
  await page.getByRole('button', { name: '快速切换', exact: true }).focus();
  await expect(editor.locator('.cm-md-math-block math')).toHaveCount(2);
  expect(state.entryById[noteA.id].body).toBe(body);
  await page.getByRole('button', { name: '阅读模式', exact: true }).click();
  await expect(page.locator('.note-reader .math-block math')).toHaveCount(2);
  await page.screenshot({ path: '../test-results/workspace/multiline-math.png' });
});

test('records initial workspace JavaScript and defers optional feature downloads', async ({ page }, testInfo) => {
  const scripts = [];
  page.on('response', response => {
    if (new URL(response.url()).pathname.endsWith('.js')) scripts.push(response.body().then(body => ({ path: new URL(response.url()).pathname, bytes: body.length, captcha: body.includes(Buffer.from('CAP_CUSTOM_WASM_URL')) })));
  });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await expect(page.locator('.codemirror-editor')).toBeVisible();
  const loaded = await Promise.all(scripts);
  const total = loaded.reduce((sum, script) => sum + script.bytes, 0);
  console.log(`Initial workspace JavaScript: ${total} bytes across ${loaded.length} modules`);
  await testInfo.attach('initial-javascript', { body: JSON.stringify({ total, loaded }, null, 2), contentType: 'application/json' });
  expect(total).toBeLessThan(1_350_000);
  expect(loaded.some(script => script.captcha)).toBe(false);
  expect(loaded.some(script => /campus-tools-|workspace-settings-|anki-workspace-/.test(script.path))).toBe(false);
});

test('failed note creation clears pending feedback and permits retry', async ({ page }) => {
  const state = defaultState();
  state.entries = [guideA];
  await mockWorkspace(page, state);
  let fail = true;
  await page.route(`**/api/libraries/${libA.id}/entries`, route => {
    if (route.request().method() !== 'POST' || !fail) return route.fallback();
    fail = false;
    return json(route, 503, { error: { id: 'unavailable' } });
  });
  await page.goto('/workspace');
  const create = page.getByRole('button', { name: '空白笔记', exact: true });
  await create.click();
  await expect(page.getByText('暂时无法创建笔记。', { exact: true })).toBeVisible();
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.locator('.note-editor')).toBeVisible();
});

test('a slow note fetch never overrides a later selection', async ({ page }) => {
  const state = defaultState();
  state.entries.push(noteC);
  state.entryById[noteC.id] = noteC;
  await mockWorkspace(page, state);
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route(`**/api/entries/${noteC.id}`, async route => {
    await hold;
    return json(route, 200, { entry: noteC });
  });
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);
  await page.getByRole('button', { name: noteC.title, exact: true }).click();
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toContainText(noteC.title);
  await page.getByRole('button', { name: noteA.title, exact: true }).click();
  release();
  await expect(page.getByRole('status', { name: '笔记操作进度' })).toHaveCount(0);
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);
});

test('startup explains the current stage and honest elapsed waiting time', async ({ page }) => {
  await page.clock.install();
  await mockWorkspace(page, defaultState());
  let release;
  const hold = new Promise(resolve => { release = resolve; });
  await page.route('**/api/decks', async route => { await hold; return route.fallback(); });
  await page.goto('/workspace');
  await expect(page.locator('.workspace-opening-now')).toContainText('同步记忆闪卡');
  await expect(page.locator('.workspace-opening-detail')).toContainText('正在读取闪卡分区与学习记录');
  await page.clock.fastForward(9000);
  await expect(page.locator('.workspace-opening-detail')).toContainText('服务器响应较慢');
  await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuetext', '阶段 5/6：同步记忆闪卡');
  release();
  await expect(page.locator('.codemirror-editor')).toBeVisible();
});

for (const action of ['create', 'study']) {
  test(`flashcard sidebar ${action} waits for its lazy module without losing the action`, async ({ page }) => {
    const state = defaultState();
    const deck = { id: 'abababababababababababababababac', name: '默认牌组', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
    state.ankiByOwner[syntheticSessionA.id] = { decks: [deck], cards: [{ id: 'abababababababababababababababad', deck_id: deck.id, front: '等待加载的卡片', back: '答案', tags: [], due: '2026-01-01T00:00:00Z', interval: 0, ease: 250, reps: 0, lapses: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }], reviews: [] };
    await mockWorkspace(page, state);
    let release;
    const hold = new Promise(resolve => { release = resolve; });
    await page.route(/\/assets\/anki-workspace-.*\.js$/, async route => { await hold; return route.continue(); });
    await page.goto('/workspace');
    await expect(page.locator('.note-title')).toBeVisible();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    if (action === 'create') await page.getByRole('button', { name: '新建卡片', exact: true }).click();
    else await page.locator('.anki-sidebar-deck').click();
    await expect(page.getByRole('status', { name: '笔记操作进度' })).toContainText('正在加载分区界面');
    release();
    if (action === 'create') await expect(page.getByRole('textbox', { name: '正面', exact: true })).toBeVisible();
    else await expect(page.locator('.anki-review-card')).toContainText('等待加载的卡片');
  });
}

test('the composer holds only the text and one button; allowance, model and thinking sit under it as text', async ({ page }) => {
  const state = defaultState();
  state.model = {
    configured: false, source: 'product', name: 'deepseek-flash', choices: ['deepseek-flash', 'gpt-6-sol-lite'],
    agent: { sandbox: true, tools: [] }, quota: { limit: 20_000_000, used: 3_400_000, remaining: 16_600_000 },
    windows: [{ id: '7d', limit: 20_000_000, used: 3_400_000, remaining: 16_600_000, unit: 'tokens', resets_at: new Date(Date.now() + 3 * 86400000).toISOString() }],
    rates: { 'deepseek-flash': 1, 'gpt-6-sol-lite': 2.5 },
  };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const composer = page.locator('form.agent-composer');
  await expect(composer.getByRole('textbox', { name: '发送给 Agent 的消息' })).toBeVisible();
  // One control in the box, and no decorative icons next to the words below it.
  await expect(composer.getByRole('button')).toHaveCount(1);
  await expect(composer.locator('svg')).toHaveCount(1);
  const meta = page.locator('.agent-composer-meta');
  await expect(meta.locator('svg')).toHaveCount(0);
  await expect(meta.getByRole('button', { name: '7 天额度剩余 83%' })).toBeVisible();
  const pair = meta.getByRole('group', { name: '模型与思考强度' });
  await expect(pair.getByRole('button', { name: '模型：蓝色大肥鱼' })).toHaveText('蓝色大肥鱼');
  await expect(pair.getByRole('button', { name: '思考强度：自动' })).toHaveText('自动');
  // The menu says how much faster a dearer model spends the allowance.
  await pair.getByRole('button', { name: '模型：蓝色大肥鱼' }).click();
  const menu = page.getByRole('menu', { name: '选择模型' });
  await expect(menu.getByRole('menuitemradio', { name: /太阳/ })).toContainText('2.5 倍额度');
  await expect(menu.getByRole('menuitemradio', { name: /蓝色大肥鱼/ })).not.toContainText('倍额度');
  // The menu opens inside the viewport although the pair sits at the right edge.
  const box = await menu.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
  await page.keyboard.press('Escape');
  // Settings show the same allowance in tokens.
  await meta.getByRole('button', { name: '7 天额度剩余 83%' }).click();
  const dialog = page.getByRole('dialog');
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
  await expect(dialog.getByRole('status')).toHaveText('340 万 / 2000 万 tokens');
  await expect(dialog).toContainText('按模型实际消耗的 token 计');
});

test('a running turn can be stopped, and the reply it leaves says so', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let stops = 0;
  await page.route('**/api/sessions/*/messages', async route => {
    const body = route.request().postDataJSON();
    await held;
    return json(route, 200, { session: { ...sessionA, messages: [
      { role: 'user', content: body.content, client_request_id: body.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '写到一半的回答', interrupted: true, created_at: '2026-01-01T00:00:11.000Z' },
    ] } });
  });
  await page.route('**/api/sessions/*/interrupt', route => { stops++; release(); return json(route, 202, { interrupted: true }); });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  // Nothing to stop while idle.
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await page.getByLabel('发送给 Agent 的消息').fill('写一篇很长的文章');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止', exact: true });
  await expect(stop).toBeVisible();
  await expect(page.getByRole('button', { name: '发送', exact: true })).toHaveCount(0);
  await stop.click();
  const reply = page.locator('.chat-message.assistant');
  await expect(reply).toContainText('写到一半的回答');
  await expect(reply.locator('.agent-reply-stopped')).toHaveText('已停止');
  expect(stops).toBe(1);
  // The turn is over: the send button is back and usable.
  await expect(page.getByRole('button', { name: '停止', exact: true })).toHaveCount(0);
  await page.getByLabel('发送给 Agent 的消息').fill('继续');
  await expect(page.getByRole('button', { name: '发送', exact: true })).toBeEnabled();
});

test('a stop the server cannot carry out leaves the turn running and says so', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => {
    const body = route.request().postDataJSON();
    await held;
    return json(route, 200, { session: { ...sessionA, messages: [
      { role: 'user', content: body.content, client_request_id: body.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '完整的回答', created_at: '2026-01-01T00:00:11.000Z' },
    ] } });
  });
  await page.route('**/api/sessions/*/interrupt', route => json(route, 503, { error: { id: 'interrupt_unavailable' } }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByLabel('发送给 Agent 的消息').fill('写一篇很长的文章');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const stop = page.getByRole('button', { name: '停止', exact: true });
  await stop.click();
  await expect(page.getByRole('alert')).toContainText('暂时无法停止这一轮');
  // Still running, and the button can be tried again.
  await expect(stop).toBeEnabled();
  release();
  const reply = page.locator('.chat-message.assistant');
  await expect(reply).toContainText('完整的回答');
  await expect(reply.locator('.agent-reply-stopped')).toHaveCount(0);
});

test('re-entering an empty conversation while it reloads shows one composer, never two', async ({ page }) => {
  const state = defaultState();
  // A conversation nobody has written in comes back without a messages field.
  const bare = { id: sessionA.id, entry_id: sessionA.entry_id, created_at: sessionA.created_at, updated_at: sessionA.updated_at };
  state.sessionsByEntry = { [sessionA.entry_id]: [bare] };
  state.sessionById = { [bare.id]: bare };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const composers = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
  await expect(page.locator('.agent-empty form.agent-composer')).toHaveCount(1);
  await expect(composers).toHaveCount(1);
  // Leave, then come back while the server copy of the conversation is slow.
  await page.getByRole('button', { name: '主页', exact: true }).click();
  await expect(composers).toHaveCount(0);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/entries/*/sessions', async route => { await held; return route.fallback(); });
  await page.route(`**/api/sessions/${sessionA.id}`, async route => { await held; return route.fallback(); });
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(composers.first()).toBeVisible();
  // The conversation kept on this device is on screen while it reloads: one composer throughout.
  for (let i = 0; i < 5; i++) {
    await expect(page.locator('form.agent-composer')).toHaveCount(1);
    await page.waitForTimeout(120);
  }
  release();
  await expect(page.locator('.agent-empty form.agent-composer')).toHaveCount(1);
  await expect(composers).toHaveCount(1);
});

test('on a phone the notes home has a composer that sends in a new conversation, and note pages have none', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let sent = null;
  await page.route('**/api/sessions/*/messages', async route => {
    sent = route.request().postDataJSON();
    const session = state.sessionById[sessionA.id];
    const next = { ...session, messages: [...session.messages,
      { role: 'user', content: sent.content, client_request_id: sent.client_request_id, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '这是今天的课表。', created_at: '2026-01-01T00:00:12.000Z' }] };
    state.sessionById[sessionA.id] = next;
    return json(route, 200, next);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);
  const ask = page.getByRole('form', { name: '问 TJUClaw' });
  // A note page, edited or read, has nothing at its foot.
  await expect(ask).toHaveCount(0);
  await page.getByRole('button', { name: '阅读模式' }).click();
  await expect(page.locator('.note-reader')).toBeVisible();
  await expect(ask).toHaveCount(0);
  // The notes home: no round buttons, one composer at the foot of the screen.
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '主页', exact: true }).click();
  await page.getByRole('button', { name: '收起侧栏' }).first().click();
  await expect(ask).toBeVisible();
  await expect(page.getByRole('button', { name: '搜索和快速切换' })).toHaveCount(0);
  await expect(page.locator('.mobile-command-bar')).toHaveCount(0);
  const box = await ask.boundingBox();
  expect(box.y + box.height).toBeGreaterThan(844 - 40);
  expect(box.x).toBeGreaterThanOrEqual(8);
  expect(box.x + box.width).toBeLessThanOrEqual(390 - 8);
  // The last thing on the page can be scrolled clear of it.
  const lastItem = page.locator('.new-note-home').locator('button').last();
  await lastItem.scrollIntoViewIfNeeded();
  expect((await lastItem.boundingBox()).y + (await lastItem.boundingBox()).height).toBeLessThanOrEqual(box.y);
  const send = ask.getByRole('button', { name: '发送' });
  await expect(send).toBeDisabled();
  // What is typed here is sent in a new conversation, whose composer is in the same place.
  await ask.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('今天有什么课');
  await send.click();
  await expect(page.locator('.chat-message.user')).toHaveText('今天有什么课');
  await expect(page.locator('.chat-message.assistant')).toContainText('这是今天的课表。');
  expect(sent.content).toBe('今天有什么课');
  await expect(ask).toHaveCount(0);
  const composer = page.locator('.agent-dock form.agent-composer');
  await expect(composer).toHaveCount(1);
  await expect(composer.getByRole('textbox')).toHaveValue('');
  const docked = await composer.boundingBox();
  expect(Math.abs(docked.x - box.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(docked.width - box.width)).toBeLessThanOrEqual(4);
});

test('the empty conversation greets with the mark and a line for the time of day, and nothing under the composer but its own row', async ({ page }) => {
  const state = defaultState();
  state.model = { ...state.model, agent: { sandbox: true, tools: ['campus_exams', 'search_course_materials', 'read_image'] } };
  await mockWorkspace(page, state);
  // Half past eight in the evening, wherever the test runs.
  await page.clock.install({ time: new Date(2026, 9, 2, 20, 30) });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const hello = page.getByRole('heading', { name: '晚上好，今天过得怎么样？' });
  await expect(hello).toBeVisible();
  await expect(hello.locator('img.brand-icon')).toHaveCount(1);
  // The mark sits left of the words on the same line, and the pair is centered over the composer.
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width === 390) await page.getByRole('button', { name: '收起侧栏' }).first().click().catch(() => undefined);
    const mark = await hello.locator('img.brand-icon').boundingBox();
    const words = await hello.locator('span').boundingBox();
    const form = await page.locator('form.agent-composer').boundingBox();
    expect(mark.x + mark.width).toBeLessThanOrEqual(words.x);
    expect(Math.abs((mark.y + mark.height / 2) - (words.y + words.height / 2))).toBeLessThan(6);
    const center = (mark.x + words.x + words.width) / 2;
    expect(Math.abs(center - (form.x + form.width / 2))).toBeLessThan(2);
    expect(mark.x).toBeGreaterThanOrEqual(form.x - 1);
    expect(words.x + words.width).toBeLessThanOrEqual(form.x + form.width + 1);
  }
  // No terminal art, no prompt line, no capability chips.
  await expect(page.locator('.agent-empty pre')).toHaveCount(0);
  await expect(page.getByText(/今天想让/)).toHaveCount(0);
  await expect(page.getByRole('list', { name: '可以使用' })).toHaveCount(0);
  await expect(page.getByText('校园服务', { exact: true })).toHaveCount(0);
});

test('the phone top bar keeps the tab pill clear of the edge above it', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue(noteA.title);
  const gap = async () => {
    const bar = await page.locator('.obsidian-topbar').boundingBox();
    const pill = await page.locator('.mobile-tab-title').boundingBox();
    return { above: pill.y - bar.y, below: bar.y + bar.height - (pill.y + pill.height) };
  };
  const note = await gap();
  expect(note.above).toBeGreaterThanOrEqual(12);
  expect(note.below).toBeGreaterThanOrEqual(4);
  // The conversation page uses the same bar.
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('button', { name: '收起侧栏' }).first().click();
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
  const session = await gap();
  expect(session.above).toBeGreaterThanOrEqual(12);
});

test('a recent card with a two-line title keeps its date inside the card', async ({ page }) => {
  const state = defaultState();
  const long = { ...noteA, id: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', title: '信号与系统期末复习提纲与历年真题整理', updated_at: '2026-10-02T08:00:00Z' };
  // Enough notes that the row is wider than a phone and scrolls sideways.
  const more = ['高数', '大学物理', '线性代数', '概率论'].map((title, index) => ({ ...noteA, id: String(index + 1).repeat(32), title, updated_at: `2026-09-0${index + 1}T08:00:00Z` }));
  state.entries = [...state.entries, long, ...more];
  for (const entry of [long, ...more]) state.entryById[entry.id] = entry;
  await mockWorkspace(page, state);
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/workspace');
    if (width === 390) {
      await page.getByRole('button', { name: /打开的标签页/ }).click();
      await page.getByRole('dialog', { name: '标签页' }).getByRole('button', { name: '新建标签页' }).click();
    } else await page.getByRole('button', { name: '新建标签页' }).click();
    const cards = page.locator('.notion-recent-card');
    const card = cards.filter({ hasText: long.title });
    await expect(card).toBeVisible();
    const boxes = await card.evaluate(node => {
      const rect = node.getBoundingClientRect();
      const title = node.querySelector('strong').getBoundingClientRect();
      const date = node.querySelector('small').getBoundingClientRect();
      return { lines: Math.round(title.height / parseFloat(getComputedStyle(node.querySelector('strong')).lineHeight)), dateBottom: date.bottom, bottom: rect.bottom, gap: date.top - title.bottom, clipped: node.scrollHeight - node.clientHeight };
    });
    expect(boxes.lines).toBe(2);
    expect(boxes.dateBottom).toBeLessThanOrEqual(boxes.bottom - 8);
    expect(boxes.gap).toBeGreaterThanOrEqual(4);
    expect(boxes.clipped).toBeLessThanOrEqual(0);
    // Every card in the row is the same height.
    const heights = await cards.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().height)));
    expect(new Set(heights).size).toBe(1);
    // The row rests with its first card whole: its outline is inside the row, not cut off at the left.
    const rest = await page.locator('.notion-recents').evaluate(list => ({ scrolled: list.scrollLeft, inset: list.querySelector('.notion-recent-card').getBoundingClientRect().left - list.getBoundingClientRect().left }));
    expect(rest.scrolled).toBe(0);
    expect(rest.inset).toBeGreaterThanOrEqual(2);
    if (process.env.SHOT) await page.locator('.notion-recents').screenshot({ path: `${process.env.SHOT}-${width}.png` });
  }
});

test('the conversation background is still by default, and the Game of Life is a setting', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('.agent-greeting')).toBeVisible();
  await expect(page.locator('canvas.life-background')).toHaveCount(0);
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: '外观', exact: true }).click();
  // An on/off setting is a switch.
  const toggle = dialog.getByRole('switch', { name: '会话背景动画' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('canvas.life-background')).toHaveCount(1);
  // The choice is remembered.
  await page.reload();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(page.locator('canvas.life-background')).toHaveCount(1);
});

test('with motion on, the newest characters of a streamed reply fade in and settle fully opaque', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await mockWorkspace(page, defaultState());
  const text = '基尔霍夫电流定律说的是：**流入节点的电流之和为零**，这是电荷守恒的直接结果。';
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  await page.route('**/api/sessions/*/live*', async route => {
    if (new URL(route.request().url()).searchParams.has('version')) await finished;
    return json(route, 200, { version: 1, count: 2, stage: { id: 'writing', ms: 0 }, rate: { tokens: 40, ms: 1000 }, items: [
      { i: 0, kind: 'thinking', text: '想一下', next: 9 },
      { i: 1, kind: 'text', text, next: new TextEncoder().encode(text).length }] });
  });
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/api/sessions/*/messages', async route => { await held; return route.fallback(); });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('什么是 KCL');
  // Catch the reply while it is still being revealed.
  await page.evaluate(() => {
    window.__tails = [];
    new MutationObserver(() => {
      const spans = [...document.querySelectorAll('.agent-live-text .agent-tail')];
      if (spans.length) window.__tails.push(spans.map(span => Number(span.style.opacity)));
    }).observe(document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.getByRole('button', { name: '发送', exact: true }).click();
  const reply = page.locator('.agent-live-text');
  // The text is complete and, once the fade has run out, plain again: nothing is left dimmed.
  await expect(reply).toHaveText(text.replaceAll('**', ''));
  await expect(reply.locator('.agent-tail')).toHaveCount(0);
  await expect(reply.locator('strong')).toHaveText('流入节点的电流之和为零');
  const tails = await page.evaluate(() => window.__tails);
  expect(tails.length).toBeGreaterThan(3);
  // While it was written, the newest characters were the lightest, never invisible, and at most a short tail.
  for (const tail of tails) {
    expect(tail.length).toBeLessThanOrEqual(14);
    expect(Math.min(...tail)).toBeGreaterThan(0);
    expect([...tail].sort((a, b) => b - a)).toEqual(tail);
  }
  // The thought before it folded into a row in place.
  await expect(page.getByRole('status', { name: /正在处理/ }).getByRole('button', { name: /思考过程/ })).toHaveAttribute('aria-expanded', 'false');
  finish();
  release();
});

const threeConversations = () => {
  const state = defaultState();
  const make = (id, question, at) => ({ id: id.repeat(32), entry_id: guideA.id, created_at: at, updated_at: at,
    messages: [{ role: 'user', content: question, created_at: at }, { role: 'assistant', content: '好的。', created_at: at }] });
  const list = [make('1', '第一个问题：电路', '2026-01-03T00:00:00.000Z'), make('2', '第二个问题：信号', '2026-01-02T00:00:00.000Z'), make('3', '第三个问题：高数', '2026-01-01T00:00:00.000Z')];
  state.sessionsByEntry[guideA.id] = list;
  for (const session of list) state.sessionById[session.id] = session;
  return { state, list };
};

test('conversation titles come with the list, all at once, without reading each conversation', async ({ page }) => {
  const { state, list } = threeConversations();
  await mockWorkspace(page, state);
  const reads = [];
  page.on('request', request => { if (/\/api\/sessions\/[0-9a-f]{32}$/.test(new URL(request.url()).pathname) && request.method() === 'GET') reads.push(request.url().slice(-32)); });
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const rows = page.locator('.conversation-row .session-tree-item');
  await expect(rows.filter({ hasText: '第二个问题：信号' })).toBeVisible();
  await expect(rows.filter({ hasText: '第三个问题：高数' })).toBeVisible();
  // Only the conversation being opened is read; the others were named by the list.
  expect(reads.filter(id => id === list[1].id || id === list[2].id)).toEqual([]);
  await expect(page.getByText('以上内容由智能体生成')).toHaveCount(0);
});

test('a server that lists no titles still names every conversation', async ({ page }) => {
  const { state } = threeConversations();
  state.listWithoutTitles = true;
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  for (const title of ['第一个问题：电路', '第二个问题：信号', '第三个问题：高数']) await expect(page.locator('.conversation-row').filter({ hasText: title })).toBeVisible();
});

test('a conversation can be renamed in place and deleted from its row', async ({ page }) => {
  const { state, list } = threeConversations();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const row = title => page.locator('.conversation-row').filter({ hasText: title });
  await expect(row('第二个问题：信号')).toBeVisible();
  // Rename from the row's menu: the field starts empty with the current title as its hint.
  await row('第二个问题：信号').getByRole('button', { name: '「第二个问题：信号」的操作' }).click();
  await page.getByRole('menu', { name: '会话操作' }).getByRole('menuitem', { name: '重命名' }).click();
  const field = page.getByRole('textbox', { name: '会话名称' });
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');
  await field.fill('  信号与系统  复习 ');
  await field.press('Enter');
  await expect(row('信号与系统 复习')).toBeVisible();
  expect(state.sessionById[list[1].id].name).toBe('信号与系统 复习');
  // The name survives a reload, and editing it again starts from the name.
  await page.reload();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  await expect(row('信号与系统 复习')).toBeVisible();
  await row('信号与系统 复习').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await expect(page.getByRole('textbox', { name: '会话名称' })).toHaveValue('信号与系统 复习');
  // Escape leaves it as it was; clearing the name returns to the first question.
  await page.getByRole('textbox', { name: '会话名称' }).press('Escape');
  await expect(row('信号与系统 复习')).toBeVisible();
  await row('信号与系统 复习').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '重命名' }).click();
  await page.getByRole('textbox', { name: '会话名称' }).fill('');
  await page.getByRole('textbox', { name: '会话名称' }).press('Enter');
  await expect(row('第二个问题：信号')).toBeVisible();
  // Deleting asks first; declining keeps the conversation.
  page.once('dialog', dialog => { expect(dialog.message()).toContain('第三个问题：高数'); void dialog.dismiss(); });
  await row('第三个问题：高数').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(row('第三个问题：高数')).toBeVisible();
  page.once('dialog', dialog => void dialog.accept());
  await row('第三个问题：高数').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(row('第三个问题：高数')).toHaveCount(0);
  expect(state.sessionById[list[2].id]).toBeUndefined();
  // Deleting the open conversation leaves a fresh one in its place.
  await row('第一个问题：电路').locator('.session-tree-item').click();
  await expect(page.locator('.chat-message.user')).toContainText('第一个问题：电路');
  page.once('dialog', dialog => void dialog.accept());
  await row('第一个问题：电路').click({ button: 'right' });
  await page.getByRole('menuitem', { name: '删除' }).click();
  await expect(row('第一个问题：电路')).toHaveCount(0);
  await expect(page.locator('.chat-message.user')).toHaveCount(0);
});

test('on a phone the search sheet fits the screen, the app ends above the keyboard, and back closes layers before leaving', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('interactive-widget=resizes-content');
  // Search: the whole sheet is on screen and its field can be typed in.
  await page.keyboard.press('Control+k');
  const sheet = page.locator('.search-palette');
  await expect(sheet).toBeVisible();
  const box = await sheet.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(390);
  expect(box.width).toBeGreaterThan(340);
  expect(box.y + box.height).toBeLessThanOrEqual(844);
  await page.getByRole('textbox', { name: '搜索' }).fill('First');
  const result = page.getByRole('listbox', { name: '搜索结果' }).getByRole('option').first();
  await expect(result).toBeVisible();
  expect((await result.boundingBox()).height).toBeGreaterThanOrEqual(44);
  // Back closes the sheet and stays in the app.
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/workspace$/);
  // Back closes the drawer next.
  await page.getByRole('button', { name: '打开侧栏' }).first().click();
  await expect(page.locator('.obsidian-app')).not.toHaveClass(/sidebar-collapsed/);
  await page.goBack();
  await expect(page.locator('.obsidian-app')).toHaveClass(/sidebar-collapsed/);
  // With nothing left to close, back says how to leave and does not leave.
  await page.goBack();
  await expect(page.getByRole('status').filter({ hasText: '再按一次返回退出' })).toBeVisible();
  await expect(page).toHaveURL(/\/workspace$/);
  await expect(page.locator('.note-title')).toHaveValue('First note for user A');
  // The keyboard's height comes off the app, and the page behind it is the theme's colour.
  const before = (await page.locator('.obsidian-app').boundingBox()).height;
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-inset', '300px'));
  expect(Math.round((await page.locator('.obsidian-app').boundingBox()).height)).toBe(Math.round(before - 300));
  const colours = await page.evaluate(() => [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.documentElement).backgroundColor, getComputedStyle(document.body).overscrollBehaviorY]);
  expect(colours[0]).toBe(colours[1]);
  expect(colours[0]).not.toBe('rgba(0, 0, 0, 0)');
  expect(colours[2]).toBe('none');
});

test('on a phone an empty conversation starts with the composer at the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).first().click();
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const greeting = page.locator('.agent-greeting');
  await expect(greeting).toBeVisible();
  // One composer, in the dock at the foot of the screen, under the greeting and not beside it.
  const composer = page.locator('form.agent-composer');
  await expect(composer).toHaveCount(1);
  await expect(page.locator('.agent-dock form.agent-composer')).toHaveCount(1);
  const form = await composer.boundingBox();
  const hello = await greeting.boundingBox();
  expect(form.y + form.height).toBeGreaterThan(844 - 120);
  expect(form.y).toBeGreaterThan(hello.y + hello.height + 80);
  expect(form.x).toBeGreaterThanOrEqual(8);
  expect(form.x + form.width).toBeLessThanOrEqual(390 - 8);
  // The keyboard's height comes off the app, so the composer rides above it.
  await page.evaluate(() => document.documentElement.style.setProperty('--keyboard-inset', '300px'));
  const raised = await composer.boundingBox();
  expect(Math.round(form.y - raised.y)).toBe(300);
  await page.evaluate(() => document.documentElement.style.removeProperty('--keyboard-inset'));
  // At a desk the same empty conversation centres the composer under the greeting.
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('.agent-empty form.agent-composer')).toHaveCount(1);
  await expect(page.locator('.agent-dock form.agent-composer')).toHaveCount(0);
});

test('a long conversation opens at its foot, and earlier replies are whole when scrolled to', async ({ page }) => {
  const state = defaultState();
  const reply = index => `## 第 ${index} 部分\n\n基尔霍夫电流定律指出，**流入节点的电流之和等于流出的电流之和**。\n\n- 第一点\n- 第二点\n- 第三点\n\n\`\`\`python\ndef kcl(currents):\n    return abs(sum(currents)) < 1e-9\n\`\`\`\n`;
  const messages = [];
  for (let index = 1; index <= 30; index++) {
    messages.push({ role: 'user', content: `讲讲第 ${index} 部分`, created_at: '2026-01-01T00:00:10.000Z' });
    messages.push({ role: 'assistant', content: reply(index), created_at: '2026-01-01T00:00:11.000Z',
      steps: [{ kind: 'thinking', text: '先回忆定律' }, { kind: 'tool', name: 'read_entry', input: '{"id":"n1"}', output: '{"id":"n1","title":"电路"}' }] });
  }
  state.sessionById[sessionA.id] = { ...sessionA, messages };
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '工作', exact: true }).click();
  const replies = page.locator('.chat-message.assistant');
  await expect(replies).toHaveCount(30);
  // The newest reply is on screen and the thread rests at its very end.
  await expect(replies.last().getByRole('heading', { name: '第 30 部分' })).toBeInViewport();
  const scroller = page.locator('.agent-scroll');
  await expect.poll(() => scroller.evaluate(node => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThanOrEqual(2);
  // Replies far above are skipped by the browser until they come near; the last few never are.
  const skipping = await page.locator('.session-transcript > .chat-message').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).contentVisibility));
  expect(skipping.slice(0, -4).every(value => value === 'auto')).toBe(true);
  expect(skipping.slice(-4).every(value => value === 'visible')).toBe(true);
  // Scrolled to, an early reply is complete: its steps, text, code and the hanging edge of its step list.
  const early = replies.nth(2);
  await early.scrollIntoViewIfNeeded();
  await expect(early.getByRole('heading', { name: '第 3 部分' })).toBeInViewport();
  await expect(early.locator('pre')).toContainText('def kcl');
  await early.getByRole('button', { name: /阅读《电路》/ }).click();
  await expect(early.locator('.agent-step-body pre').first()).toBeVisible();
  const edge = await early.evaluate(node => {
    const list = node.querySelector('.agent-steps-list').getBoundingClientRect();
    const box = node.getBoundingClientRect();
    // How far the list hangs outside its reply, and how far outside the reply may still be painted.
    return { hang: Math.round(box.left - list.left), margin: parseFloat(getComputedStyle(node).overflowClipMargin) || 0 };
  });
  expect(edge.margin).toBeGreaterThanOrEqual(edge.hang);
  // Sending from the foot still lands at the foot.
  await scroller.evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.getByRole('textbox', { name: '发送给 Agent 的消息' }).fill('继续');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(page.locator('.chat-message.assistant')).toHaveCount(31);
  await expect.poll(() => scroller.evaluate(node => Math.round(node.scrollHeight - node.clientHeight - node.scrollTop))).toBeLessThanOrEqual(2);
});

test('adds, checks, pauses and removes MCP servers without showing their keys', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  const catalog = [
    { id: 'deepwiki', title: 'DeepWiki', publisher: 'Cognition', summary: '读懂 GitHub 上的开源项目', description: '按仓库名查询文档。', homepage: 'https://deepwiki.com', auth: 'none' },
    { id: 'amap', title: '高德地图', publisher: '高德开放平台', summary: '地点搜索、路线规划和天气', description: '需要 Web 服务 Key。', homepage: 'https://lbs.amap.com', auth: 'query', key_label: 'Web 服务 Key', key_help: '在控制台创建', key_url: 'https://console.amap.com' },
  ];
  const servers = [];
  const requests = [];
  await page.route('**/api/account/mcp**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : null;
    requests.push({ method: request.method(), path, body });
    const reply = (status, value) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (path === '/api/account/mcp' && request.method() === 'GET') return reply(200, { catalog, servers });
    if (path === '/api/account/mcp' && request.method() === 'POST') {
      const entry = catalog.find(item => item.id === body.catalog_id);
      const server = { id: `s${servers.length + 1}`, catalog_id: body.catalog_id, name: body.catalog_id ?? body.name, title: entry?.title ?? (body.title || 'mcp.example.com'),
        url: entry ? undefined : body.url, auth: entry?.auth ?? body.auth, has_secret: Boolean(body.secret), enabled: true };
      servers.push(server);
      return reply(201, { server });
    }
    const id = path.split('/')[4];
    const server = servers.find(item => item.id === id);
    if (path.endsWith('/check')) return server.title === '高德地图'
      ? reply(502, { error: { id: 'mcp_unauthorized' } })
      : reply(200, { tools: [{ name: 'read_wiki_structure', description: '' }, { name: 'ask_wiki_question', description: '' }] });
    if (request.method() === 'PATCH') { Object.assign(server, body.enabled === undefined ? {} : { enabled: body.enabled }); return reply(200, { server }); }
    if (request.method() === 'DELETE') { servers.splice(servers.indexOf(server), 1); return route.fulfill({ status: 204 }); }
    return reply(404, {});
  });
  await page.goto('/workspace');
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: 'MCP 服务' }).click();
  const settings = page.getByRole('dialog');
  await expect(settings.getByText('还没有添加 MCP 服务。')).toBeVisible();

  // A keyless catalog server is added at once and checked.
  await settings.getByRole('article', { name: 'DeepWiki' }).getByRole('button', { name: '添加' }).click();
  await expect(settings.getByText('连接正常，提供 2 个工具：read_wiki_structure、ask_wiki_question')).toBeVisible();
  await expect(settings.getByRole('article', { name: 'DeepWiki' }).getByText('已添加')).toBeVisible();

  // One that needs a key asks for it, with where to get one.
  const amap = settings.getByRole('article', { name: '高德地图' });
  await amap.getByRole('button', { name: '添加' }).click();
  await expect(amap.getByRole('link', { name: '前往获取' })).toHaveAttribute('href', 'https://console.amap.com');
  await amap.getByLabel('Web 服务 Key').fill('amap-secret-key');
  await amap.getByRole('button', { name: '保存并添加' }).click();
  await expect(settings.getByText('服务拒绝了访问，请检查密钥是否正确、是否有权限。')).toBeVisible();
  expect(requests.find(item => item.body?.catalog_id === 'amap').body).toEqual({ catalog_id: 'amap', secret: 'amap-secret-key' });
  await expect(settings.getByText('已设置密钥')).toBeVisible();
  await expect(settings.getByText('amap-secret-key')).toHaveCount(0);

  // Any Streamable HTTP server can be added by address.
  await settings.getByRole('button', { name: '添加自定义服务' }).click();
  await settings.getByLabel('服务地址').fill('https://mcp.example.com/mcp');
  await settings.getByLabel('工具前缀').fill('course');
  await settings.getByLabel('认证方式').selectOption('bearer');
  await settings.getByLabel('密钥', { exact: true }).fill('custom-token');
  await settings.locator('form').getByRole('button', { name: '添加' }).click();
  await expect.poll(() => requests.find(item => item.body?.name === 'course')?.body).toEqual({ name: 'course', title: '', url: 'https://mcp.example.com/mcp', auth: 'bearer', auth_name: '', secret: 'custom-token' });
  await expect(settings.getByText('https://mcp.example.com/mcp')).toBeVisible();

  // Pausing keeps the server; removing asks first.
  await settings.getByRole('checkbox').first().click();
  await expect.poll(() => requests.some(item => item.method === 'PATCH' && item.body?.enabled === false)).toBe(true);
  await expect(settings.getByText('已停用')).toBeVisible();
  page.once('dialog', dialog => dialog.accept());
  await settings.getByRole('button', { name: '移除「DeepWiki」' }).click();
  await expect(settings.getByRole('button', { name: '移除「DeepWiki」' })).toHaveCount(0);
  await expect(settings.getByRole('article', { name: 'DeepWiki' }).getByRole('button', { name: '添加' })).toBeVisible();
});

test('the graph zooms with the wheel and buttons, fits the window and finds a note', async ({ page }) => {
  const state = defaultState();
  const second = { ...noteA, id: '33333333333333333333333333333333', title: 'Second note', body: 'Backlink' };
  state.entries = state.entries.map(entry => entry.id === noteA.id ? { ...entry, body: '[[Second note]]' } : entry).concat(second);
  state.entryById[noteA.id] = { ...noteA, body: '[[Second note]]' };
  state.entryById[second.id] = second;
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '知识图谱' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('2 篇笔记 · 1 条链接')).toBeVisible();
  const zoom = dialog.locator('.graph-zoom');
  const percent = async () => Number((await zoom.textContent()).replace('%', ''));
  const fitted = await percent();
  await dialog.getByRole('button', { name: '放大' }).click();
  expect(await percent()).toBeGreaterThan(fitted);
  await dialog.getByRole('button', { name: '缩小' }).click();
  await dialog.getByRole('button', { name: '缩小' }).click();
  expect(await percent()).toBeLessThan(fitted);
  // The wheel zooms around the pointer.
  const stage = dialog.locator('.graph-stage');
  const box = await stage.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await percent();
  await page.mouse.wheel(0, -400);
  await expect.poll(percent).toBeGreaterThan(before);
  // Dragging the background pans: the layer's transform moves.
  const layer = dialog.locator('.graph-canvas > g');
  const moved = await layer.getAttribute('transform');
  await page.mouse.move(box.x + 40, box.y + 40);
  await page.mouse.down();
  await page.mouse.move(box.x + 140, box.y + 90, { steps: 5 });
  await page.mouse.up();
  expect(await layer.getAttribute('transform')).not.toBe(moved);
  await dialog.getByRole('button', { name: '适应窗口' }).click();
  expect(await percent()).toBe(fitted);
  // Searching lights the note and its neighbour and dims nothing else here.
  await dialog.getByRole('searchbox', { name: '在图谱中查找笔记' }).fill('Second');
  await expect(dialog.locator('.graph-node.is-focus')).toHaveAttribute('aria-label', '打开笔记 Second note');
  await dialog.getByRole('searchbox', { name: '在图谱中查找笔记' }).fill('不存在');
  await expect(dialog.getByText('无匹配')).toBeVisible();
});

test('on a phone, Settings lists its sections and drills into one with a way back', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockWorkspace(page, defaultState());
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏' }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const nav = page.getByRole('navigation', { name: '设置分类' });
  await expect(nav).toBeVisible();
  // Opening does not raise the keyboard by focusing the search field.
  await expect(dialog.getByRole('searchbox', { name: '搜索设置' })).not.toBeFocused();
  await nav.getByRole('button', { name: '外观' }).click();
  await expect(nav).toBeHidden();
  await expect(dialog.getByRole('heading', { name: '外观' })).toBeVisible();
  await expect(dialog.getByRole('switch', { name: '会话背景动画' })).toBeVisible();
  await dialog.getByRole('button', { name: '设置', exact: true }).click();
  await expect(nav).toBeVisible();
  await nav.getByRole('button', { name: '账户' }).click();
  await expect(dialog.getByRole('heading', { name: '账户' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

test('the library menu renames, exports a ZIP, imports Markdown and a ZIP, and deletes only after typing the name', async ({ page }) => {
  const state = defaultState();
  const folder = { ...noteA, id: '55555555555555555555555555555555', kind: 'folder', title: '课程', body: undefined };
  const inFolder = { ...noteA, id: '66666666666666666666666666666666', parent_id: folder.id, title: '电路', body: '# KCL' };
  state.entries.push(folder, inFolder);
  state.entryById[folder.id] = folder;
  state.entryById[inFolder.id] = inFolder;
  await mockWorkspace(page, state);
  let deleted = false;
  await page.route(`**/api/libraries/${libA.id}`, async route => {
    const method = route.request().method();
    if (method === 'PATCH') {
      state.libraries[0] = { ...state.libraries[0], name: JSON.parse(route.request().postData()).name };
      return json(route, 200, { library: state.libraries[0] });
    }
    if (method === 'DELETE') { deleted = true; return route.fulfill({ status: 204 }); }
    return route.fallback();
  });
  await page.route(`**/api/libraries/${libA.id}/folders`, route => route.request().method() === 'GET'
    ? json(route, 200, { folders: state.entries.filter(entry => entry.kind === 'folder') })
    : route.fallback());
  await page.goto('/workspace');
  const button = page.locator('.sidebar-library-button');
  const menu = page.getByRole('dialog', { name: '管理知识库' });

  // Rename in place.
  await button.click();
  await menu.getByRole('menuitem', { name: '重命名' }).click();
  await menu.getByRole('textbox', { name: '知识库名称' }).fill('电子信息笔记');
  await menu.getByRole('button', { name: '保存' }).click();
  await expect(menu.getByText('已重命名。')).toBeVisible();
  await expect(button).toContainText('电子信息笔记');

  // Export: a ZIP with the folder kept as a directory.
  const download = page.waitForEvent('download');
  await menu.getByRole('menuitem', { name: /导出为 ZIP/ }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('电子信息笔记.zip');
  const { unzipSync, strFromU8 } = await import('fflate');
  const zipped = unzipSync(new Uint8Array(await readFile(await file.path())));
  expect(strFromU8(zipped['课程/电路.md'])).toBe('# KCL');
  expect(strFromU8(zipped['First note for user A.md'])).toBe(noteA.body);
  await expect(menu.getByText(/已导出 2 项/)).toBeVisible();

  // Import: a Markdown file and a ZIP whose folders are recreated.
  const archive = zipSync({ '期末/复习.md': strToU8('# 复习'), '期末/.DS_Store': strToU8('x') });
  await menu.getByLabel('选择要导入的文件').setInputFiles([
    { name: '随记.md', mimeType: 'text/markdown', buffer: Buffer.from('今天的想法') },
    { name: '资料.zip', mimeType: 'application/zip', buffer: Buffer.from(archive) },
  ]);
  await expect(menu.getByText('已导入 2 篇笔记，新建 1 个文件夹。')).toBeVisible();
  expect(state.entries.some(entry => entry.title === '随记' && entry.body === '今天的想法')).toBe(true);
  const created = state.entries.find(entry => entry.kind === 'folder' && entry.title === '期末');
  expect(state.entries.some(entry => entry.title === '复习' && entry.parent_id === created?.id)).toBe(true);
  await expect(page.locator('.obsidian-sidebar').getByText('随记').first()).toBeVisible();

  // Delete asks for the exact name first.
  await menu.getByRole('menuitem', { name: '删除知识库' }).click();
  const confirm = menu.getByRole('button', { name: '永久删除' });
  await expect(confirm).toBeDisabled();
  await menu.getByRole('textbox', { name: /确认删除/ }).fill('电子信息');
  await expect(confirm).toBeDisabled();
  await menu.getByRole('textbox', { name: /确认删除/ }).fill('电子信息笔记');
  await confirm.click();
  await expect.poll(() => deleted).toBe(true);
});

test('the sidebar opens plugins and MCP in their own centre; campus tools are a built-in plugin', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  await page.route('**/api/account/skills**', route => json(route, 200, { skills: [] }));
  await page.route('**/api/account/mcp**', route => json(route, 200, { catalog: [], servers: [] }));
  await page.goto('/workspace');
  const sidebar = page.locator('.obsidian-sidebar');
  await expect(sidebar.getByRole('button', { name: '小工具', exact: true })).toHaveCount(0);
  await sidebar.getByRole('button', { name: 'MCP 服务', exact: true }).click();
  const centre = page.getByRole('dialog');
  await expect(centre.getByRole('heading', { name: 'MCP 服务' })).toBeVisible();
  await expect(centre.getByRole('tab', { name: 'MCP' })).toHaveAttribute('aria-selected', 'true');
  await centre.getByRole('tab', { name: '插件' }).click();
  await expect(centre.getByRole('heading', { name: '插件' })).toBeVisible();
  await centre.getByRole('button', { name: '打开校园小工具' }).click();
  await expect(centre).toHaveCount(0);
  await expect(page.locator('section.campus-tool')).toBeVisible();
});

test('on a phone the menu button opens the drawer even at its very edge, and the drawer covers the home composer', async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  try {
    const state = defaultState();
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    const opener = page.getByRole('button', { name: '打开侧栏' });
    const box = await opener.boundingBox();
    // A tap at the button's left edge, inside the screen-edge swipe zone.
    await page.touchscreen.tap(box.x + 3, box.y + box.height / 2);
    await expect(page.locator('.obsidian-app')).not.toHaveClass(/sidebar-collapsed/);
    // Home's composer floats at the foot; the drawer is above it.
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '主页', exact: true }).click();
    const composer = page.getByRole('form', { name: '问 TJUClaw' });
    await expect(composer).toBeVisible();
    if (await page.locator('.obsidian-app').evaluate(element => element.classList.contains('sidebar-collapsed'))) await page.getByRole('button', { name: '打开侧栏' }).click();
    await expect.poll(() => page.locator('.obsidian-sidebar').evaluate(element => Math.round(element.getBoundingClientRect().left))).toBe(0);
    const area = await composer.boundingBox();
    const top = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('.obsidian-sidebar') !== null, { x: area.x + 20, y: area.y + area.height / 2 });
    expect(top).toBe(true);
  } finally {
    await context.close();
  }
});

test('the work view groups conversations by host, project and folder, and moves and starts them in place', async ({ page }) => {
  const state = defaultState();
  const project = { id: 'p1'.padEnd(32, '0'), host: 'ws:laptop', name: 'tjuclaw', path: '/home/me/tjuclaw', created_at: '2026-01-01T00:00:00Z' };
  state.workLayout = { projects: [project], folders: [] };
  const sessions = [
    { ...sessionA, id: 'a1'.padEnd(32, '0'), name: '修复登录页', host: 'ws:laptop', project_id: project.id },
    { ...sessionA, id: 'a2'.padEnd(32, '0'), name: '随便问问' },
  ];
  state.sessionsByEntry[guideA.id] = sessions;
  for (const item of sessions) state.sessionById[item.id] = item;
  await mockWorkspace(page, state);
  const created = [];
  await page.route('**/api/work/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const body = request.postData() ? JSON.parse(request.postData()) : {};
    if (path === '/api/work/layout') return json(route, 200, { layout: state.workLayout });
    if (path === '/api/work/projects' && request.method() === 'POST') {
      if (body.host !== 'cloud' && !body.path?.startsWith('/')) return json(route, 400, { error: { id: 'invalid_project' } });
      const made = { id: `p${state.workLayout.projects.length + 1}`.padEnd(32, '0'), created_at: '2026-01-02T00:00:00Z', ...body };
      state.workLayout.projects.push(made); created.push(made);
      return json(route, 201, { project: made });
    }
    if (path === '/api/work/folders' && request.method() === 'POST') {
      const folder = { id: 'f1'.padEnd(32, '0'), name: body.name, created_at: '2026-01-02T00:00:00Z' };
      state.workLayout.folders.push(folder);
      return json(route, 201, { folder });
    }
    const folderPath = path.match(/^\/api\/work\/folders\/(\w+)$/);
    if (folderPath && request.method() === 'PATCH') {
      const folder = state.workLayout.folders.find(item => item.id === folderPath[1]);
      folder.name = body.name;
      return json(route, 200, { folder });
    }
    return route.fallback();
  });
  await page.route('**/api/workspaces', route => json(route, 200, { workspaces: [{ id: 'laptop', name: '我的电脑', kind: 'local', capabilities: [], online: true, last_seen_at: null, created_at: '2026-01-01T00:00:00Z' }] }));
  await page.goto('/workspace');
  const sidebar = page.locator('.obsidian-sidebar');
  await sidebar.getByRole('button', { name: '工作', exact: true }).click();
  const tree = sidebar.locator('.work-tree');

  // Hosts first: the cloud and the registered computer; its project holds its conversation.
  await expect(tree.getByRole('button', { name: /^云端沙箱/ })).toBeVisible();
  await expect(tree.getByText('随便问问')).toBeVisible();
  await tree.getByRole('button', { name: /^我的电脑/ }).click();
  await tree.getByRole('button', { name: /^tjuclaw/ }).click();
  await expect(tree.getByText('修复登录页')).toBeVisible();

  // A computer's project needs its directory; a cloud project does not.
  await tree.getByRole('button', { name: '在「我的电脑」新建项目' }).click();
  const dialog = page.getByRole('dialog', { name: '新建项目' });
  await dialog.getByLabel('项目名称').fill('课程设计');
  await expect(dialog.getByRole('button', { name: '创建项目' })).toBeDisabled();
  await dialog.getByLabel('文件夹路径').fill('/home/me/课程设计');
  await dialog.getByRole('button', { name: '创建项目' }).click();
  await expect(dialog).toHaveCount(0);
  expect(created[0]).toMatchObject({ host: 'ws:laptop', name: '课程设计', path: '/home/me/课程设计' });
  await expect(tree.getByRole('button', { name: /^课程设计/ })).toBeVisible();

  // A folder is named in place.
  await tree.getByRole('button', { name: '新建会话文件夹' }).click();
  await tree.getByRole('textbox', { name: '文件夹名称' }).fill('期末');
  await tree.getByRole('textbox', { name: '文件夹名称' }).press('Enter');
  await expect(tree.getByRole('button', { name: /^期末/ })).toBeVisible();

  // Moving a conversation into the folder.
  await tree.getByRole('button', { name: '「随便问问」的操作' }).click();
  await page.getByRole('menuitem', { name: '移动到…' }).click();
  await page.getByRole('dialog', { name: '移动到' }).getByRole('option', { name: '期末' }).click();
  await expect.poll(() => state.placements?.at(-1)).toMatchObject({ id: sessions[1].id, folder_id: 'f1'.padEnd(32, '0') });
  await expect(tree.locator('.work-node', { hasText: '期末' }).getByText('随便问问')).toBeVisible();

  // A conversation started from a project is placed in it.
  await tree.getByRole('button', { name: '在「课程设计」中新建对话' }).click();
  await expect.poll(() => state.placements?.some(item => item.project_id === created[0].id)).toBe(true);
});

test('a terminal opens on a connected computer in a project directory and relays typing and output', async ({ page }) => {
  const state = defaultState();
  const project = { id: 'p1'.padEnd(32, '0'), host: 'ws:laptop', name: 'tjuclaw', path: '/home/me/tjuclaw', created_at: '2026-01-01T00:00:00Z' };
  state.workLayout = { projects: [project], folders: [] };
  await mockWorkspace(page, state);
  await page.route('**/api/work/layout', route => json(route, 200, { layout: state.workLayout }));
  await page.route('**/api/workspaces', route => json(route, 200, { workspaces: [
    { id: 'laptop', name: '我的电脑', kind: 'local', capabilities: ['terminal.open'], online: true, last_seen_at: null, created_at: '2026-01-01T00:00:00Z' },
    { id: 'lab', name: '实验室', kind: 'local', capabilities: ['pi.prompt'], online: true, last_seen_at: null, created_at: '2026-01-01T00:00:00Z' },
  ] }));
  const opened = [];
  const typed = [];
  let closed = 0;
  const outputs = [btoa('me@laptop:~/tjuclaw$ ')];
  await page.route('**/api/workspaces/laptop/terminals', async route => {
    opened.push(JSON.parse(route.request().postData()));
    return json(route, 201, { terminal: { id: 'term1', workspace_id: 'laptop', state: 'opening' } });
  });
  let cursor = 0;
  await page.route('**/api/terminals/term1/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const body = JSON.parse(route.request().postData() || '{}');
    if (path.endsWith('/input')) {
      if (body.data) {
        const text = atob(body.data);
        typed.push(text);
        if (text.includes('\r')) outputs.push(btoa('\r\nREADME.md  frontend\r\nme@laptop:~/tjuclaw$ '));
      }
      return route.fulfill({ status: 204 });
    }
    if (path.endsWith('/read')) {
      const next = outputs.shift();
      if (!next) { await new Promise(resolve => setTimeout(resolve, 200)); return json(route, 200, { data: '', cursor: body.cursor, state: 'open', skipped: false }); }
      cursor += atob(next).length;
      return json(route, 200, { data: next, cursor, state: 'open', skipped: false });
    }
    return route.fallback();
  });
  await page.route('**/api/terminals/term1', route => { closed++; return route.fulfill({ status: 204 }); });
  await page.goto('/workspace');
  const sidebar = page.locator('.obsidian-sidebar');
  await sidebar.getByRole('button', { name: '工作', exact: true }).click();
  const tree = sidebar.locator('.work-tree');

  // Only the computer that allows terminals offers one.
  await expect(tree.getByRole('button', { name: '打开「我的电脑」的终端' })).toBeVisible();
  await expect(tree.getByRole('button', { name: '打开「实验室」的终端' })).toHaveCount(0);

  // From the project's menu: the shell starts in the project's directory.
  await tree.getByRole('button', { name: /^我的电脑/ }).click();
  await tree.getByRole('button', { name: '「tjuclaw」的操作' }).click();
  await page.getByRole('menuitem', { name: '在终端中打开' }).click();
  const dock = page.getByRole('region', { name: '终端' });
  await expect(dock).toBeVisible();
  await expect.poll(() => opened[0]).toMatchObject({ cwd: '/home/me/tjuclaw' });
  expect(opened[0].cols).toBeGreaterThan(10);
  await expect(dock.locator('.xterm-rows')).toContainText('me@laptop:~/tjuclaw$');
  await expect(dock.getByRole('tab', { name: /tjuclaw/ }).locator('.terminal-dot')).toHaveClass(/is-open/);

  // Typing reaches the computer; its answer is drawn.
  await dock.locator('.xterm-helper-textarea').focus();
  await page.keyboard.type('ls');
  await page.keyboard.press('Enter');
  await expect.poll(() => typed.join('')).toBe('ls\r');
  await expect(dock.locator('.xterm-rows')).toContainText('README.md  frontend');

  // Closing the tab ends the shell and the dock.
  await dock.getByRole('button', { name: '关闭终端 tjuclaw' }).click();
  await expect(dock).toHaveCount(0);
  await expect.poll(() => closed).toBe(1);
});

test('spreadsheets preview as a grid with sheet tabs', async ({ page }) => {
  const state = defaultState();
  const xlsx = readFileSync(new URL('./fixtures/grades.xlsx', import.meta.url));
  const sheet = { ...noteA, id: '99999999999999999999999999999997', kind: 'file', title: '成绩.xlsx', content_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: xlsx.length, body: undefined };
  state.entries.push(sheet);
  state.entryById[sheet.id] = sheet;
  await mockWorkspace(page, state);
  await page.route(`**/api/entries/${sheet.id}/file`, route => route.fulfill({ status: 200, contentType: sheet.content_type, body: xlsx }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '成绩.xlsx' }).click();
  const grid = page.getByRole('region', { name: '工作表 成绩' });
  await expect(grid.getByRole('columnheader')).toHaveText(['', 'A', 'B', 'C', 'D', 'E', 'F']);
  await expect(grid.getByRole('row').nth(2)).toContainText('3021001张三9288.5TRUE');
  await expect(grid.getByRole('row').nth(3)).toContainText('李四, Jr.');
  await expect(grid.getByRole('row').nth(4)).toContainText('王五');
  await page.getByRole('tab', { name: '备注' }).click();
  const notes = page.getByRole('region', { name: '工作表 备注' });
  await expect(notes).toContainText('说明');
  await expect(notes.getByRole('row').nth(3).getByRole('cell').nth(2)).toHaveText('含 "引号" 与换行\n第二行');
});

test('the CLI sign-in page shows the request and allows it', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  const decided = [];
  await page.route('**/api/cli/device/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === 'GET' && path === '/api/cli/device/WDJB-MJHT') return json(route, 200, { name: 'tjuclaw @ laptop', created_at: '2026-10-05T04:00:00Z', user_code: 'WDJB-MJHT' });
    if (request.method() === 'GET') return json(route, 404, { error: { id: 'device_code_not_found' } });
    decided.push(path);
    return json(route, 200, { approved: path.endsWith('/approve') });
  });
  await page.goto('/device?code=wdjbmjht');
  await expect(page.getByRole('heading', { name: '授权 TJUClaw CLI' })).toBeVisible();
  await expect(page.getByLabel('验证码 WDJB-MJHT')).toBeVisible();
  await expect(page.getByText('tjuclaw @ laptop')).toBeVisible();
  await expect(page.getByText('查看模型密钥、MCP 设置和对话')).toBeVisible();
  await page.getByRole('button', { name: '允许' }).click();
  await expect(page.getByRole('heading', { name: '已授权' })).toBeVisible();
  expect(decided).toEqual(['/api/cli/device/WDJB-MJHT/approve']);

  // A code typed by hand that is unknown or expired says so.
  await page.goto('/device');
  await page.getByLabel('验证码').fill('BBBB-CCCC');
  await page.getByRole('button', { name: '继续' }).click();
  await expect(page.getByRole('alert')).toContainText('已过期');
});

test('signing in from the CLI page returns to it', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.route('**/api/auth/session', route => json(route, 401, { error: { id: 'session_required' } }));
  await page.goto('/device?code=WDJB-MJHT');
  await expect(page).toHaveURL(/\/auth\/login$/);
  expect(await page.evaluate(() => sessionStorage.getItem('tjuclaw.return.v1'))).toBe('/device?code=WDJB-MJHT');
});

test('notes show Obsidian embeds and relative images from the library', async ({ page }) => {
  const state = defaultState();
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const folder = { ...noteA, id: '77777777777777777777777777777771', kind: 'folder', title: 'assets', body: undefined };
  const first = { ...noteA, id: '77777777777777777777777777777772', kind: 'file', title: '图1.png', parent_id: folder.id, content_type: 'image/png', size: png.length, body: undefined };
  const second = { ...noteA, id: '77777777777777777777777777777773', kind: 'file', title: '图2.png', parent_id: folder.id, content_type: 'image/png', size: png.length, body: undefined };
  const note = { ...noteA, id: '77777777777777777777777777777774', title: '课程笔记', body: '# 课程笔记\n\n![[图1.png|200]]\n\n![示意](assets/%E5%9B%BE2.png)\n\n`![[图1.png]]` 在代码里不变\n' };
  state.entries.push(folder, first, second, note);
  for (const entry of [folder, first, second, note]) state.entryById[entry.id] = entry;
  await mockWorkspace(page, state);
  for (const file of [first, second]) await page.route(`**/api/entries/${file.id}/file`, route => route.fulfill({ status: 200, contentType: 'image/png', body: png }));
  await page.goto('/workspace');
  await page.getByRole('button', { name: '课程笔记' }).click();
  // The editor shows the embed as the image away from the caret.
  await expect(page.locator(`.cm-content img[src="/api/entries/${first.id}/file"]`)).toBeVisible();
  await expect(page.locator(`.cm-content img[src="/api/entries/${second.id}/file"]`)).toBeVisible();
  // The reader too, with the requested width; code keeps the embed as text.
  await page.getByRole('button', { name: '阅读模式' }).first().click();
  const reader = page.locator('.note-reader');
  await expect(reader.locator(`img[src="/api/entries/${first.id}/file"]`)).toHaveAttribute('width', '200');
  await expect(reader.locator(`img[src="/api/entries/${second.id}/file"]`)).toHaveAttribute('alt', '示意');
  await expect(reader.locator('code')).toContainText('![[图1.png]]');
});

test('the library name in the sidebar switches between libraries and remembers the choice', async ({ page }) => {
  const state = defaultState();
  // libB's id: the mock unlocks it on this device like libA.
  const vault = { ...libB, name: 'vault', created_at: '2026-01-02T00:00:00.000Z' };
  state.libraries = [libA, vault];
  await mockWorkspace(page, state);
  const vaultNote = { ...noteA, id: 'dddddddddddddddddddddddddddddddd', library_id: vault.id, title: '课程总览', body: undefined };
  await page.route(`**/api/libraries/${vault.id}/entries`, route => json(route, 200, { entries: [vaultNote] }));
  await page.route(`**/api/libraries/${vault.id}/folders`, route => json(route, 200, { folders: [] }));
  await page.goto('/workspace');
  const sidebar = page.locator('.obsidian-sidebar');
  await expect(sidebar.getByRole('button', { name: 'First note for user A' })).toBeVisible();

  await page.locator('.sidebar-library-button').click();
  const menu = page.getByRole('dialog', { name: '管理知识库' });
  await expect(menu.getByRole('menuitemradio')).toHaveText(['我的知识库', 'vault']);
  await expect(menu.getByRole('menuitemradio', { name: '我的知识库' })).toHaveAttribute('aria-checked', 'true');
  await menu.getByRole('menuitemradio', { name: 'vault' }).click();

  // The page reopens on the chosen library, and stays there.
  await expect(sidebar.getByRole('button', { name: '课程总览' })).toBeVisible();
  await expect(page.locator('.sidebar-library-button')).toHaveAttribute('title', 'vault');
  await page.reload();
  await expect(sidebar.getByRole('button', { name: '课程总览' })).toBeVisible();
  await page.locator('.sidebar-library-button').click();
  await expect(page.getByRole('dialog', { name: '管理知识库' }).getByRole('menuitemradio', { name: 'vault' })).toHaveAttribute('aria-checked', 'true');
});

// Draft account checks use isolated verification routes, never the live session.
for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`campus draft verification is independent and never saves ${viewport.width}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await mockWorkspace(page, defaultState());
    const requests = [];
    let captchaCount = 0;
    let officeAttempts = 0;
    await page.route('**/api/campus/**', route => {
      const path = new URL(route.request().url()).pathname;
      requests.push(path);
      if (path.endsWith('/wpy/verify')) {
        expect(route.request().postDataJSON()).toEqual({ account: 'draft-wpy', password: 'fixture-wpy' });
        return json(route, 200, { valid: true });
      }
      if (path.endsWith('/accounts/office/captcha')) return json(route, 200, {
        captcha_id: `draft-${++captchaCount}`, content_type: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', expires_at: '2099-01-01T00:00:00Z',
      });
      if (path.endsWith('/office/verify')) {
        expect(route.request().postDataJSON()).toEqual({ username: 'draft-office', password: 'fixture-office', captcha_id: `draft-${captchaCount}`, captcha: officeAttempts ? '5678' : '1234' });
        return ++officeAttempts === 1 ? json(route, 401, { error: { id: 'campus_office_credentials_invalid' } }) : json(route, 200, { valid: true });
      }
      return json(route, 500, { error: { id: 'unexpected_live_login' } });
    });
    await page.goto('/workspace');
    if (viewport.width < 600) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
    const settings = page.getByRole('dialog');
    await expect(settings.getByRole('button', { name: '验证微北洋账号' })).toBeDisabled();
    await settings.getByRole('textbox', { name: /^微北洋账号/ }).fill(' draft-wpy ');
    await expect(settings.getByRole('button', { name: '验证微北洋账号' })).toBeDisabled();
    await settings.getByLabel('微北洋密码').fill('fixture-wpy');
    await settings.getByRole('button', { name: '验证微北洋账号' }).click();
    await expect(settings.getByText('微北洋验证通过，尚未保存。')).toBeVisible();
    await settings.getByRole('textbox', { name: /^办公网账号/ }).fill('draft-office');
    await settings.getByLabel('办公网密码').fill('fixture-office');
    await settings.getByRole('button', { name: '验证办公网账号' }).click();
    await expect(settings.getByRole('img', { name: '办公网验证图片' })).toBeVisible();
    await settings.getByLabel('验证办公网验证码').fill('1234');
    await settings.getByLabel('验证办公网验证码').press('Enter');
    await expect(settings.getByText('办公网账号、密码或验证码有误，请检查后重新验证。')).toBeVisible();
    await expect(settings.getByRole('img', { name: '办公网验证图片' })).toHaveCount(0);
    await settings.getByRole('button', { name: '验证办公网账号' }).click();
    await settings.getByRole('button', { name: '刷新验证图片' }).click();
    await settings.getByLabel('验证办公网验证码').fill('5678');
    await settings.getByRole('button', { name: '提交办公网验证' }).click();
    await expect(settings.getByText('办公网验证通过，尚未保存。')).toBeVisible();
    await expect(settings.getByText('微北洋验证通过，尚未保存。')).toBeVisible();
    await settings.getByLabel('微北洋密码').fill('changed');
    await expect(settings.getByText('微北洋验证通过，尚未保存。')).toHaveCount(0);
    await expect(settings.getByText('办公网验证通过，尚未保存。')).toBeVisible();
    expect(await page.evaluate(owner => localStorage.getItem(`tjuclaw.campus.credentials.v1.${owner}`), syntheticSessionA.id)).toBeNull();
    expect(requests.every(path => path.includes('/accounts/'))).toBe(true);
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    await page.screenshot({ path: `test-results/workspace/campus-verification-${viewport.width}.png` });
  });
}

for (const fixture of [
  { id: 'campus_auth_rejected', code: 50003, status: 502, text: '微北洋认证服务未接受请求（服务码 50003）；无法据此判断密码是否正确，请反馈此服务码。' },
  { id: 'campus_invalid_response', code: 0, status: 502, text: '微北洋未返回可确认的登录结果（服务码 0）；不代表密码错误，请稍后重试或反馈此提示。' },
  { id: 'campus_invalid_response', status: 502, text: '微北洋未返回可确认的登录结果；不代表密码错误，请稍后重试或反馈此提示。' },
  { id: 'campus_invalid_credentials', code: 40002, status: 401, text: '微北洋服务未找到该账号（服务码 40002）。若官方 App 可登录，可尝试用学号验证，或反馈此服务码。' },
  { id: 'campus_invalid_credentials', code: 40004, status: 401, text: '微北洋服务拒绝了这次登录（服务码 40004）。若官方 App 可登录，请反馈此服务码，不必反复修改密码。' },
  { id: 'campus_auth_rejected', code: '<untrusted-provider-message>', status: 502, text: '微北洋认证服务未接受请求；无法据此判断密码是否正确，请反馈此提示。' },
]) {
  test(`campus Wpy login diagnostics do not mislabel service failures (${fixture.id}, ${fixture.code})`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    const requests = [];
    const account = 'fixture+user@example.com';
    const password = ' 合成 +&%= / 密码 ';
    await page.route('**/api/campus/accounts/wpy/verify', async route => {
      requests.push(route.request().postDataJSON());
      await json(route, fixture.status, { error: { id: fixture.id, upstream_code: fixture.code } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
    const settings = page.getByRole('dialog');
    await settings.getByRole('textbox', { name: /^微北洋账号/ }).fill(account);
    await settings.getByLabel('微北洋密码').fill(password);
    await settings.getByRole('button', { name: '验证微北洋账号' }).click();
    await expect(settings.getByText(fixture.text, { exact: true })).toBeVisible();
    await expect(settings.getByText('微北洋账号或密码不正确，请检查后重试。')).toHaveCount(0);
    expect(requests).toEqual([{ account, password }]);
    expect(await page.evaluate(owner => localStorage.getItem(`tjuclaw.campus.credentials.v1.${owner}`), syntheticSessionA.id)).toBeNull();
    expect(await settings.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
    if (fixture.code === 50003) await page.screenshot({ path: 'test-results/workspace/wpy-login-diagnostic-390.png' });
  });
}

test('campus draft verification discards late responses, captcha and identity drafts', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  let release;
  let started;
  const waiting = new Promise(resolve => { started = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  await page.route('**/api/campus/accounts/wpy/verify', async route => {
    started(); await blocked;
    await json(route, 200, { valid: true }).catch(() => {});
  });
  await page.goto('/workspace');
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
  const settings = page.getByRole('dialog');
  await settings.getByRole('textbox', { name: /^微北洋账号/ }).fill('old-draft');
  await settings.getByLabel('微北洋密码').fill('fixture');
  await settings.getByRole('button', { name: '验证微北洋账号' }).click();
  await waiting;
  await settings.getByLabel('微北洋密码').fill('new-fixture');
  release();
  await expect(settings.getByRole('button', { name: '验证微北洋账号' })).toBeEnabled();
  await expect(settings.getByText('微北洋验证通过，尚未保存。')).toHaveCount(0);
  state.session = syntheticSessionB; state.libraries = [libB]; state.entries = [{ ...guideB }];
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await expect.poll(() => page.evaluate(() => JSON.stringify(localStorage))).toContain(syntheticSessionB.id);
  await expect(page.getByRole('navigation', { name: '设置分类' })).toBeVisible();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
  await expect(page.getByRole('dialog').getByRole('textbox', { name: /^微北洋账号/ })).toHaveValue('');
  await expect(page.getByRole('dialog').getByLabel('微北洋密码')).toHaveValue('');
});

for (const width of [320, 360, 390, 1440]) {
  test(`campus notebook timetable fits seven days without sideways scrolling (${width})`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 360 ? 800 : 844 });
    await mockWorkspace(page, defaultState());
    await page.addInitScript(owner => localStorage.setItem(`tjuclaw.campus.data.v1.${owner}`, JSON.stringify({
      courses: [
        { id: 'fixture-mon', name: '概率论与数理统计', place: '45-B201', teacher: '合成教师', day: 0, start: 1, end: 4, color: 0 },
        { id: 'fixture-thu', name: '软件工程1（双语）', place: '46-A408', day: 3, start: 5, end: 6, color: 1 },
        { id: 'fixture-sun', name: '编译原理与技术', place: '46-A212', day: 6, start: 9, end: 12, color: 2 },
        { id: 'fixture-bridge', name: '跨午间课程', place: '33-140', day: 2, start: 4, end: 5, color: 3 },
      ], grades: [],
    })), syntheticSessionA.id);
    await page.goto('/workspace');
    if (width < 720) await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
    await page.getByRole('treeitem', { name: '课程表校园笔记', exact: true }).getByRole('button', { name: '课程表', exact: true }).click();
    const tool = page.getByRole('region', { name: '课程表小工具' });
    await expect(tool.getByRole('heading', { name: '课程表', exact: true })).toBeVisible();
    if (width < 720) await expect(page.getByRole('button', { name: /^标签页：课程表，/ })).toBeVisible();
    else await expect(page.getByRole('tab', { name: '笔记 课程表', exact: true })).toBeVisible();
    await expect(tool.locator('.campus-week-day')).toHaveCount(7);
    const widths = await tool.evaluate(node => {
      const week = node.querySelector('.campus-week');
      const last = week.querySelector('.campus-week-day:last-child').getBoundingClientRect();
      return { body: document.documentElement.scrollWidth, window: window.innerWidth, scroll: node.scrollWidth,
        client: node.clientWidth, grid: week.scrollWidth, gridClient: week.clientWidth, right: last.right };
    });
    expect(widths.body).toBeLessThanOrEqual(widths.window);
    expect(widths.scroll).toBeLessThanOrEqual(widths.client + 1);
    expect(widths.grid).toBeLessThanOrEqual(widths.gridClient + 1);
    expect(widths.right).toBeLessThanOrEqual(width);
    const course = tool.getByRole('button', { name: /^概率论与数理统计，/ });
    await course.click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('heading', { name: '概率论与数理统计' })).toBeVisible();
    await expect(dialog.getByText('45-B201', { exact: true })).toBeVisible();
    await expect(dialog.getByText('合成教师', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: '关闭课程详情' }).click();
    await expect(tool.getByRole('button', { name: /^跨午间课程，/ })).toHaveCount(2);
    await tool.getByRole('button', { name: /^跨午间课程，/ }).first().click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: '跨午间课程' })).toBeVisible();
    await page.getByRole('button', { name: '关闭课程详情' }).click();
    await page.screenshot({ path: `test-results/workspace/campus-notebook-${width}-light.png` });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await page.screenshot({ path: `test-results/workspace/campus-notebook-${width}-dark.png` });
    await tool.getByRole('button', { name: '下一周' }).click();
    await expect(tool.getByRole('button', { name: /^软件工程1（双语），/ })).toBeVisible();
    await tool.getByRole('button', { name: '今天', exact: true }).click();
    expect(await page.evaluate(owner => JSON.parse(localStorage.getItem(`tjuclaw.campus.data.v1.${owner}`)).courses.length, syntheticSessionA.id)).toBe(4);
  });
}

test('campus notebook entries can be removed, restored and remain account/library scoped', async ({ page }) => {
  const state = defaultState();
  await mockWorkspace(page, state);
  await page.goto('/workspace');
  const snapshot = structuredClone(state.entries);
  page.on('dialog', dialog => dialog.accept());
  for (const name of ['课程表', '入校码']) {
    const row = page.getByRole('treeitem', { name: `${name}校园笔记`, exact: true });
    await row.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
    await row.getByRole('button', { name: `${name}笔记操作` }).click();
    await page.getByRole('menuitem', { name: '删除', exact: true }).click();
    await expect(row).toHaveCount(0);
  }
  await page.reload();
  await expect(page.getByRole('treeitem', { name: '课程表校园笔记' })).toHaveCount(0);
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
  await page.getByRole('button', { name: '恢复课程表', exact: true }).click();
  await expect(page.getByRole('button', { name: '打开课程表', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('treeitem', { name: '课程表校园笔记' })).toBeVisible();
  await expect(page.getByRole('treeitem', { name: '入校码校园笔记' })).toHaveCount(0);
  expect(state.entries).toEqual(snapshot);
  const visibility = await page.evaluate(() => Object.entries(localStorage).filter(([key]) => key.startsWith('tjuclaw.campus.notes.v1.')));
  expect(visibility).toEqual([[`tjuclaw.campus.notes.v1.${syntheticSessionA.id}.${libA.id}`, '["entry"]']]);
  state.session = syntheticSessionB; state.libraries = [libB]; state.entries = [{ ...guideB }];
  await page.reload();
  await expect(page.getByRole('treeitem', { name: '入校码校园笔记' })).toBeVisible();
});

test('office-only draft checks use the teaching protocol without saving credentials or asking for an invented captcha', async ({ page }) => {
  await mockWorkspace(page, defaultState());
  const posts = [];
  await page.route('**/api/campus/**', route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    if (path === '/api/campus/accounts/office/captcha') return json(route, 200, { captcha_required: false, captcha_id: 'fixture-teaching-check', expires_at: '2099-01-01T00:00:00Z' });
    if (path === '/api/campus/accounts/office/verify') { posts.push(request.postDataJSON()); return json(route, 200, { valid: true }); }
    return json(route, 401, { error: { id: 'campus_office_session_required' } });
  });
  await page.goto('/workspace');
  await page.locator('.obsidian-sidebar').getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '校园账号' }).click();
  await page.getByRole('textbox', { name: /^办公网账号/ }).fill('fixture-office');
  await page.getByLabel('办公网密码').fill('fixture-password');
  await page.getByRole('button', { name: '验证办公网账号', exact: true }).click();
  await expect(page.getByText('办公网验证通过，尚未保存。')).toBeVisible();
  await expect(page.getByRole('img', { name: '办公网验证图片' })).toHaveCount(0);
  expect(posts).toEqual([{ username: 'fixture-office', password: 'fixture-password', captcha_id: 'fixture-teaching-check', captcha: '' }]);
  expect(await page.evaluate(owner => localStorage.getItem(`tjuclaw.campus.credentials.v1.${owner}`), syntheticSessionA.id)).toBeNull();
});

test('partially overlapping timetable courses stay separately tappable and do not cover the next section', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 800 });
  await mockWorkspace(page, defaultState());
  await page.addInitScript(owner => localStorage.setItem(`tjuclaw.campus.data.v1.${owner}`, JSON.stringify({
    courses: [
      { id: 'a', name: '短课', place: '', day: 0, start: 1, end: 2, color: 0 },
      { id: 'b', name: '长课', place: '', day: 0, start: 1, end: 4, color: 1 },
      { id: 'c', name: '中课', place: '', day: 0, start: 2, end: 3, color: 2 },
      { id: 'd', name: '后课', place: '', day: 0, start: 3, end: 4, color: 3 },
    ], grades: [],
  })), syntheticSessionA.id);
  await page.goto('/workspace');
  await page.getByRole('button', { name: '打开侧栏', exact: true }).click();
  await page.getByRole('treeitem', { name: '课程表校园笔记' }).getByRole('button', { name: '课程表', exact: true }).click();
  const courses = page.locator('.campus-class');
  await expect(courses).toHaveCount(4);
  const geometry = await courses.evaluateAll(nodes => nodes.map(node => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, height: rect.height };
  }));
  for (let i = 0; i < geometry.length; i++) {
    expect(geometry[i].height).toBeGreaterThanOrEqual(44);
    for (let j = i + 1; j < geometry.length; j++) {
      expect(geometry[i].bottom <= geometry[j].top || geometry[j].bottom <= geometry[i].top).toBe(true);
    }
  }
  for (const name of ['短课', '长课', '中课', '后课']) {
    await page.getByRole('button', { name: new RegExp(`^${name}，`) }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name, exact: true })).toBeVisible();
    await page.getByRole('button', { name: '关闭课程详情' }).click();
  }
});

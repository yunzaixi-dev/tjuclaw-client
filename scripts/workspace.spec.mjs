import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';
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
      const entry = { ...createdNote, parent_id: posted.parent_id || '', kind: posted.kind || 'note', title: posted.title || createdNote.title, ...(posted.body === undefined ? {} : { body: posted.body }) };
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
      sessions: (state.sessionsByEntry[sessions[1]] ?? []).map(session => ({
        id: session.id, entry_id: session.entry_id, created_at: session.created_at, updated_at: session.updated_at,
      })),
    });
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
    await page.evaluate(() => sessionStorage.clear());
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
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
    await page.reload();
    await expect(page.getByRole('heading', { name: '解锁工作区' })).toBeVisible();
    await page.getByLabel('工作区口令').fill('wrong-remote-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('alert')).toContainText('口令不正确');
    await page.getByLabel('工作区口令').fill('remote-workspace-secret');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await expect(page.getByRole('button', { name: 'First note for user A', exact: true })).toBeVisible();
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
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
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
    if (await page.getByRole('button', { name: '稍后再说' }).count()) await page.getByRole('button', { name: '稍后再说' }).click();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.getByRole('button', { name: '同步校园账号' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.getByRole('button', { name: '同步校园账号' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.getByRole('button', { name: '同步校园账号' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect.poll(() => officeLogins).toBe(1);
    await page.getByRole('button', { name: '稍后再说' }).click();
    await page.getByRole('button', { name: '锁定' }).click();
    const response = page.waitForResponse(res => new URL(res.url()).pathname === '/api/campus/office/session' && res.request().method() === 'POST');
    releaseOffice();
    await response;
    await expect(page.getByRole('button', { name: '解锁已绑定账号' })).toBeVisible();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.getByRole('textbox', { name: '课程名' }).fill('手动课程');
    await page.getByRole('button', { name: '添加到课表' }).click();
    await expect(page.locator('.campus-class')).toContainText('手动课程');
    await page.getByRole('button', { name: '同步校园账号' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
    await page.getByRole('textbox', { name: '图片验证码' }).fill('1234');
    await page.getByRole('dialog').getByRole('button', { name: '连接办公网' }).click();
    await expect(page.locator('.campus-schedule-nav')).toContainText('第 1 教学周');
    await expect(page.locator('.campus-class')).toContainText('第一周课程');
    await expect(page.locator('.campus-class')).not.toContainText('手动课程');
    await expect(page.getByRole('button', { name: '删除课程 手动课程' })).toBeVisible();
    await expect(page.locator('.campus-class')).not.toContainText('第二周课程');
    await page.getByRole('button', { name: '下一周' }).click();
    await expect(page.locator('.campus-schedule-nav')).toContainText('第 2 教学周');
    await expect(page.locator('.campus-class')).toContainText('第二周课程');
    await expect(page.locator('.campus-class')).not.toContainText('第一周课程');
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.getByRole('button', { name: '同步校园账号' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
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
    await page.getByRole('button', { name: '稍后再说' }).click();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '论坛' }).click();
    await page.getByRole('button', { name: '绑定账号后查看' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
    await page.getByRole('button', { name: '稍后再说' }).click();
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
    await page.getByRole('button', { name: '锁定' }).click();
    await expect(page.locator('.campus-forum-list li')).toHaveCount(0);
    await expect(page.getByRole('button', { name: '绑定账号后查看' })).toBeVisible();
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
    await page.getByRole('button', { name: '小工具', exact: true }).click();
    await page.locator('.campus-sidebar-list').getByRole('button', { name: '空教室' }).click();
    await page.getByRole('button', { name: '绑定账号后读取' }).click();
    if (await page.getByRole('button', { name: '更换绑定' }).count()) await page.getByRole('button', { name: '更换绑定' }).click();
    await page.getByRole('textbox', { name: '微北洋账号', exact: true }).fill('campus-user');
    await page.getByLabel('微北洋密码').fill('campus-password');
    await page.getByRole('textbox', { name: '办公网账号', exact: true }).fill('office-user');
    await page.getByLabel('办公网密码').fill('office-password');
    await page.getByLabel('本地独立解锁口令（至少 12 位）').fill('long-local-secret-2026');
    await page.getByRole('button', { name: '绑定并加密保存' }).click();
    await page.getByRole('button', { name: '稍后再说' }).click();
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
    const secondNote = { ...noteC, created_at: '2026-01-01T00:00:02.000Z' };
    state.entries.push(secondNote);
    state.entryById[noteC.id] = secondNote;
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
    expect(state.sentRequests).toHaveLength(2);
    expect(state.sentRequests[1].client_request_id).toBe(state.sentRequests[0].client_request_id);
    expect(state.sentRequests[0].client_request_id).toMatch(/^[0-9a-f]{32}$/);
  });

  test('opens the Git notebook from the workspace without starting another Agent session', async ({ page }) => {
    const state = defaultState();
    await mockWorkspace(page, state);
    let sessionReads = 0;
    let sessionCreates = 0;
    let grants = 0;
    const requests = [];
    await page.route(`**/api/entries/${guideA.id}/sessions`, route => {
      if (route.request().method() === 'POST') sessionCreates++;
      else sessionReads++;
      return json(route, 200, { sessions: [sessionA] });
    });
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route => {
      grants++;
      return json(route, 200, { token: 'git-notes-only', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' });
    });
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      requests.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify(route.request().url().endsWith('/notes')
          ? { version: 'session.v1', paths: ['repo.md'], revision: 'a'.repeat(40) }
          : { version: 'session.v1', path: 'repo.md', content: 'Forgejo version', revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Git 笔记' })).toBeVisible();
    await expect(page.getByText(/旧资料夹仍是独立的知识库，尚未迁移；当前 Git 仓库未启用端到端加密/)).toBeVisible();
    expect(sessionReads).toBe(0);
    expect(grants).toBe(0);
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await expect(panel).toBeVisible();
    expect(sessionReads).toBe(1);
    expect(sessionCreates).toBe(0);
    expect(grants).toBe(0);
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'repo.md' }).click();
    await expect(panel.locator('pre')).toContainText('Forgejo version');
    expect(grants).toBe(2);
    expect(requests).toEqual([
      expect.objectContaining({ owner_id: syntheticSessionA.id, session_id: sessionA.id, entry_id: guideA.id }),
      expect.objectContaining({ owner_id: syntheticSessionA.id, session_id: sessionA.id, entry_id: guideA.id, path: 'repo.md' }),
    ]);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    expect(sessionCreates).toBe(0);
    await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toBeVisible();
  });

  test('creates and reopens browser-encrypted private notes in Forgejo without exposing titles or bodies', async ({ page }) => {
    const state = defaultState();
    state.vaultConfigured = true;
    await mockWorkspace(page, state, { seedWorkspaceUnlock: false });
    let loggedOut = false;
    let logoutCalls = 0;
    await page.route('**/api/auth/session', route => loggedOut
      ? json(route, 401, { error: { id: 'session_required' } })
      : json(route, 200, syntheticSessionA));
    await page.route('**/api/auth/logout', route => {
      logoutCalls++;
      loggedOut = true;
      return json(route, 200, {});
    });
    const objects = new Map();
    const writes = [];
    let counter = 0;
    let sandboxGrants = 0;
    await page.route('**/api/sessions/*/sandbox-token', route => {
      sandboxGrants++;
      return json(route, 503, { error: { id: 'unexpected_sandbox_access' } });
    });
    await page.route('**/api/vault/objects/*', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      const stored = objects.get(id);
      if (route.request().method() === 'GET') {
        return stored ? route.fulfill({ status: 200, contentType: 'application/vnd.tjuclaw.sealed+json',
          headers: { ETag: stored.revision }, body: JSON.stringify(stored.object) })
          : json(route, 404, { error: { id: 'vault_object_not_found' } });
      }
      expect(route.request().method()).toBe('PUT');
      const headers = route.request().headers();
      if (stored ? headers['if-match'] !== stored.revision : headers['if-none-match'] !== '*') {
        return json(route, 409, { error: { id: 'vault_revision_conflict' } });
      }
      const revision = `"${(++counter).toString(16).padStart(40, '0')}"`;
      const payload = route.request().postData();
      writes.push(payload);
      objects.set(id, { revision, object: JSON.parse(payload) });
      return route.fulfill({ status: stored ? 200 : 201, contentType: 'application/json',
        headers: { ETag: revision }, body: '{"ok":true}' });
    });
    await page.goto('/workspace');
    await page.getByRole('textbox', { name: '创建工作区口令' }).fill('private-workspace-key');
    await page.getByLabel('再次输入口令').fill('private-workspace-key');
    await page.getByRole('checkbox').check();
    const downloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: '创建并下载备份' }).click();
    await downloadPromise;
    await page.getByRole('button', { name: '我已安全备份，进入工作区' }).click();
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    const panel = page.getByRole('region', { name: '私密笔记' });
    await expect(panel).toContainText('云端 Agent 不会读取这里的内容');
    await panel.getByLabel('再次输入工作区口令以解密私密笔记').fill('private-workspace-key');
    await panel.getByRole('button', { name: '解锁私密笔记' }).click();
    await panel.getByLabel('新笔记标题').fill('仅本人可见的标题');
    await panel.getByRole('button', { name: '新建私密笔记' }).click();
    await panel.getByRole('textbox', { name: '私密笔记正文' }).fill('仅本人可见的正文');
    await panel.getByRole('button', { name: '保存密文' }).click();
    await expect(panel.locator('pre')).toHaveText('仅本人可见的正文');
    expect(sandboxGrants).toBe(0);
    expect(writes).toHaveLength(4);
    for (const payload of writes) expect(payload).not.toMatch(/仅本人可见|private-workspace-key/);
    await panel.getByRole('button', { name: '编辑笔记' }).click();
    await panel.getByRole('textbox', { name: '私密笔记正文' }).fill('切换视图后保留的草稿');
    await page.getByRole('button', { name: '普通 Markdown · Agent 可用' }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    const restored = page.getByRole('region', { name: '私密笔记' });
    await restored.getByLabel('再次输入工作区口令以解密私密笔记').fill('private-workspace-key');
    await restored.getByRole('button', { name: '解锁私密笔记' }).click();
    await expect(restored.getByRole('textbox', { name: '私密笔记正文' })).toHaveValue('切换视图后保留的草稿');
    expect(writes).toHaveLength(4);
    await restored.getByRole('button', { name: '保存密文' }).click();
    await expect(restored.locator('pre')).toHaveText('切换视图后保留的草稿');
    expect(writes).toHaveLength(5);
    for (const payload of writes) expect(payload).not.toMatch(/仅本人可见|切换视图后保留的草稿|private-workspace-key/);
    await page.reload();
    await page.getByLabel('工作区口令').fill('private-workspace-key');
    await page.getByRole('button', { name: '解锁进入工作区' }).click();
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    const reopened = page.getByRole('region', { name: '私密笔记' });
    await reopened.getByLabel('再次输入工作区口令以解密私密笔记').fill('private-workspace-key');
    await reopened.getByRole('button', { name: '解锁私密笔记' }).click();
    await reopened.getByRole('button', { name: '仅本人可见的标题' }).click();
    await expect(reopened.locator('pre')).toHaveText('切换视图后保留的草稿');
    await reopened.getByRole('button', { name: '修改标题' }).click();
    await reopened.getByLabel('修改私密笔记标题').fill('改名后仅本人可见');
    await reopened.getByRole('button', { name: '保存标题' }).click();
    await expect(reopened.getByRole('button', { name: '改名后仅本人可见' })).toBeVisible();
    expect(writes).toHaveLength(6);
    for (const payload of writes) expect(payload).not.toMatch(/改名后仅本人可见/);
    await reopened.getByRole('button', { name: '修改标题' }).click();
    await reopened.getByLabel('修改私密笔记标题').fill('不应覆盖并发修改');
    objects.get(createHash('sha256').update(`tjuclaw:private-notebook:v1:${libA.id}`).digest('hex').slice(0, 32)).revision =
      '"ffffffffffffffffffffffffffffffffffffffff"';
    await reopened.getByRole('button', { name: '保存标题' }).click();
    await expect(reopened.getByRole('alert')).toContainText('远端版本已更新');
    await expect(reopened.getByRole('button', { name: '改名后仅本人可见' })).toBeVisible();
    expect(writes).toHaveLength(6);
    await reopened.getByRole('button', { name: '取消改名' }).click();
    await reopened.getByRole('button', { name: '编辑笔记' }).click();
    await reopened.getByRole('textbox', { name: '私密笔记正文' }).fill('远端移除后仍需保留的草稿');
    const manifestID = createHash('sha256').update(`tjuclaw:private-notebook:v1:${libA.id}`).digest('hex').slice(0, 32);
    expect(objects.delete(manifestID)).toBe(true);
    await page.getByRole('button', { name: '普通 Markdown · Agent 可用' }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    const orphaned = page.getByRole('region', { name: '私密笔记' });
    await orphaned.getByLabel('再次输入工作区口令以解密私密笔记').fill('private-workspace-key');
    await orphaned.getByRole('button', { name: '解锁私密笔记' }).click();
    await expect(orphaned.getByRole('textbox', { name: '私密笔记正文' })).toHaveValue('远端移除后仍需保留的草稿');
    await expect(orphaned.getByRole('alert')).toContainText('远端目录已移除');
    await expect(orphaned.getByRole('button', { name: '保存密文' })).toBeDisabled();
    await expect(orphaned.getByRole('button', { name: '复制草稿' })).toBeVisible();
    expect(writes).toHaveLength(6);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('未保存的草稿');
      return dialog.dismiss();
    });
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    expect(logoutCalls).toBe(0);
    await page.getByRole('button', { name: '关闭设置' }).click();
    await expect(orphaned.getByRole('textbox', { name: '私密笔记正文' })).toHaveValue('远端移除后仍需保留的草稿');
    await page.getByRole('button', { name: '设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '账户' }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '退出登录', exact: true }).click();
    await expect(page).toHaveURL(/\/auth\/logged-out/);
    expect(logoutCalls).toBe(1);
  });

  test('never downgrades private notes to plaintext when the Forgejo vault is disabled', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let objectReads = 0;
    await page.route('**/api/vault/objects/*', route => {
      objectReads++;
      return json(route, 503, { error: { id: 'vault_unavailable' } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    await expect(page.getByRole('region', { name: '私密笔记' })).toContainText('不会回退到明文存储');
    expect(objectReads).toBe(0);
  });

  test('copies a legacy Markdown note into sealed Forgejo objects without changing the original', async ({ page }) => {
    const state = defaultState();
    state.vaultConfigured = true;
    await mockWorkspace(page, state, { seedWorkspaceUnlock: false });
    const objects = new Map();
    const writes = [];
    let counter = 0;
    await page.route('**/api/vault/objects/*', route => {
      const id = new URL(route.request().url()).pathname.split('/').at(-1);
      const stored = objects.get(id);
      if (route.request().method() === 'GET') {
        return stored ? route.fulfill({ status: 200, contentType: 'application/vnd.tjuclaw.sealed+json',
          headers: { ETag: stored.revision }, body: JSON.stringify(stored.object) })
          : json(route, 404, { error: { id: 'vault_object_not_found' } });
      }
      expect(route.request().method()).toBe('PUT');
      const headers = route.request().headers();
      if (stored ? headers['if-match'] !== stored.revision : headers['if-none-match'] !== '*') {
        return json(route, 409, { error: { id: 'vault_revision_conflict' } });
      }
      const payload = route.request().postData();
      writes.push(payload);
      const revision = `"${(++counter).toString(16).padStart(40, '0')}"`;
      objects.set(id, { revision, object: JSON.parse(payload) });
      return route.fulfill({ status: stored ? 200 : 201, contentType: 'application/json',
        headers: { ETag: revision }, body: '{"ok":true}' });
    });
    await page.goto('/workspace');
    await page.getByRole('textbox', { name: '创建工作区口令' }).fill('private-workspace-key');
    await page.getByLabel('再次输入口令').fill('private-workspace-key');
    await page.getByRole('checkbox').check();
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '创建并下载备份' }).click();
    await download;
    await page.getByRole('button', { name: '我已安全备份，进入工作区' }).click();
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '私密笔记 · 浏览器解密' }).click();
    const panel = page.getByRole('region', { name: '私密笔记' });
    await panel.getByLabel('再次输入工作区口令以解密私密笔记').fill('private-workspace-key');
    await panel.getByRole('button', { name: '解锁私密笔记' }).click();
    await panel.getByRole('button', { name: '查看可复制的旧 Markdown' }).click();
    await expect(panel.getByLabel('选择一篇旧资料库笔记')).toHaveValue(noteA.id);
    page.once('dialog', dialog => {
      expect(dialog.message()).toContain('原件仍以明文留在旧资料库');
      return dialog.accept();
    });
    await panel.getByRole('button', { name: '复制并核对密文' }).click();
    await expect(panel.getByRole('status')).toContainText('密文已回读核对');
    await expect(panel.locator('pre')).toHaveText(noteA.body);
    await panel.getByRole('button', { name: '查看可复制的旧 Markdown' }).click();
    await expect(panel.getByText('没有可复制的旧 Markdown。')).toBeVisible();
    expect(state.entryById[noteA.id]).toEqual(noteA);
    expect(writes).toHaveLength(3);
    for (const payload of writes) expect(payload).not.toMatch(/First note for user A|Private note body|private-workspace-key|legacy_entry_id/);
  });

  test('retains an unsaved Git draft when switching between the notebook and Agent', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'draft-scoped-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const writes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().method() === 'PATCH') writes.push(route.request().postDataJSON());
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify(route.request().url().endsWith('/notes')
          ? { version: 'session.v1', paths: ['draft.md'], revision: 'a'.repeat(40) }
          : { version: 'session.v1', path: 'draft.md', content: 'old text', revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    let panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'draft.md' }).click();
    await panel.getByRole('button', { name: '编辑文件' }).click();
    await panel.getByRole('textbox', { name: '沙箱文件内容' }).fill('local unsaved draft');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toHaveValue('local unsaved draft');
    expect(writes).toHaveLength(0);
  });

  test('confirms a Git note save by reading Forgejo after a lost gateway response', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'write-scoped-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    let content = 'old text';
    let revision = 'a'.repeat(40);
    let patches = 0;
    let reads = 0;
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: ['draft.md'], revision }) });
      if (route.request().method() === 'PATCH') {
        patches++;
        expect(route.request().postDataJSON().expected_revision).toBe('a'.repeat(40));
        content = route.request().postDataJSON().content;
        revision = 'b'.repeat(40);
        return route.fulfill({ status: 503, contentType: 'application/json', headers, body: '{}' });
      }
      reads++;
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', path: 'draft.md', content, revision }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'draft.md' }).click();
    await panel.getByRole('button', { name: '编辑文件' }).click();
    await panel.getByRole('textbox', { name: '沙箱文件内容' }).fill('saved despite 503');
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.locator('pre')).toContainText('saved despite 503');
    expect(patches).toBe(1);
    expect(reads).toBe(2);
  });

  test('retains the Git draft when a conflict read-back differs', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'write-scoped-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    let content = 'old text';
    let revision = 'a'.repeat(40);
    let patches = 0;
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().url().endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: ['draft.md'], revision }) });
      if (route.request().method() === 'PATCH') {
        patches++;
        content = 'someone else changed the note';
        revision = 'b'.repeat(40);
        return route.fulfill({ status: 409, contentType: 'application/json', headers, body: '{}' });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', path: 'draft.md', content, revision }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'draft.md' }).click();
    await panel.getByRole('button', { name: '编辑文件' }).click();
    await panel.getByRole('textbox', { name: '沙箱文件内容' }).fill('keep this local draft');
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.getByRole('alert')).toContainText('远端文件已更新');
    await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toHaveValue('keep this local draft');
    expect(patches).toBe(1);
  });

  test('keeps the Git notebook disconnected on failed session lookup and allows retry', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    let attempts = 0;
    await page.route(`**/api/entries/${guideA.id}/sessions`, route => {
      attempts++;
      return attempts === 1 ? json(route, 503, { error: { id: 'unavailable' } })
        : json(route, 200, { sessions: [sessionA] });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    await expect(page.getByRole('alert')).toContainText('无法连接 Git 工作区');
    await page.getByRole('button', { name: '重试连接' }).click();
    await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toBeVisible();
    expect(attempts).toBe(2);
  });

  test('creates one Agent session on demand when opening the Git notebook for the first time', async ({ page }) => {
    const state = defaultState();
    state.sessionsByEntry[guideA.id] = [];
    await mockWorkspace(page, state);
    let created = 0;
    await page.route(`**/api/entries/${guideA.id}/sessions`, route => {
      if (route.request().method() === 'POST') {
        created++;
        state.sessionsByEntry[guideA.id] = [sessionA];
        return json(route, 201, { session: sessionA });
      }
      return json(route, 200, { sessions: state.sessionsByEntry[guideA.id] });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    expect(created).toBe(0);
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toBeVisible();
    expect(created).toBe(1);
    await page.getByRole('button', { name: '资料夹', exact: true }).click();
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toBeVisible();
    expect(created).toBe(1);
  });

  test('opens the Git notebook on a narrow mobile viewport', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await mockWorkspace(page, defaultState());
    await page.goto('/workspace');
    await page.getByRole('button', { name: '打开 Git 笔记' }).click();
    await expect(page.getByRole('region', { name: 'Git 笔记' })).toBeVisible();
    await expect(page.getByRole('button', { name: '连接 Git 工作区' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });

  test('reads committed Agent Git notes directly from the gateway with a session token', async ({ page }) => {
    const state = defaultState();
    const calls = [];
    let issued = 0;
    await mockWorkspace(page, state);
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route => {
      issued++;
      return json(route, 200, { token: 'short-lived-session-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' });
    });
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      calls.push({ path: new URL(route.request().url()).pathname, headers: route.request().headers(),
        body: route.request().postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify(route.request().url().endsWith('/notes')
          ? { version: 'session.v1', paths: ['course/agent-note.md', 'course/backlink.md'], revision: 'a'.repeat(40) }
          : route.request().url().endsWith('/graph')
            ? { version: 'session.v1', nodes: ['course/agent-note.md', 'course/backlink.md'],
              edges: [{ source: 'course/backlink.md', target: 'course/agent-note.md' }], revision: 'a'.repeat(40) }
            : { version: 'session.v1', path: route.request().postDataJSON().path,
              content: '<script>alert(1)</script>\nAgent work', revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toBeVisible();
    expect(issued).toBe(0);
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'course/agent-note.md' }).click();
    await expect(panel.locator('pre')).toContainText('<script>alert(1)</script>');
    await expect(panel.locator('script')).toHaveCount(0);
    expect(issued).toBe(2);
    expect(calls.map(call => call.path)).toEqual(['/v1/sessions/notes', '/v1/sessions/note']);
    for (const call of calls) {
      expect(call.headers.authorization).toBe('Bearer short-lived-session-token');
      expect(call.body).toMatchObject({ owner_id: syntheticSessionA.id, session_id: sessionA.id,
        entry_id: guideA.id, profile: 'study-guide', version: 'session.v1' });
    }
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('short-lived-session-token');
    await panel.getByRole('button', { name: '查看图谱' }).click();
    await expect(panel.getByText('2 篇笔记 · 1 条链接')).toBeVisible();
    await expect(panel.getByText('反向链接')).toBeVisible();
    await panel.locator('.sandbox-notes-connections').getByRole('button', { name: 'course/backlink.md' }).click();
    await expect(panel.locator('.sandbox-notes-preview-heading')).toContainText('course/backlink.md');
    expect(calls.slice(2).map(call => call.path)).toEqual(['/v1/sessions/graph', '/v1/sessions/note']);
  });

  test('shows a stale-list hint when an authorized Git note has disappeared', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'workspace-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      return route.request().url().endsWith('/notes')
        ? route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', paths: ['deleted.md'], revision: 'a'.repeat(40) }) })
        : route.fulfill({ status: 404, contentType: 'application/json', headers,
          body: JSON.stringify({ error: { id: 'note_not_found' } }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Git 笔记', exact: true }).click();
    await page.getByRole('button', { name: '连接 Git 工作区' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'deleted.md' }).click();
    await expect(panel.getByRole('alert')).toHaveText('笔记不存在或已被其他设备删除，请刷新文件列表。');
    await expect(panel.locator('.sandbox-notes-preview')).toHaveCount(0);
  });

  test('saves a Git note conditionally and keeps a conflicting draft', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'session-only-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const writes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().url().endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: ['note.md'], revision: 'a'.repeat(40) }) });
      if (route.request().method() === 'PATCH') {
        writes.push({ body: route.request().postDataJSON(), token: route.request().headers().authorization });
        if (writes.length === 2) return route.fulfill({ status: 409, contentType: 'application/json', headers,
          body: JSON.stringify({ error: 'note_conflict' }) });
        return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', path: 'note.md', revision: 'b'.repeat(40) }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', path: 'note.md', content: 'first revision',
          revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'note.md' }).click();
    await panel.getByRole('button', { name: '编辑文件' }).click();
    const draft = panel.getByRole('textbox', { name: '沙箱文件内容' });
    await draft.fill('saved by browser');
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.locator('pre')).toHaveText('saved by browser');
    expect(writes[0]).toMatchObject({ body: { path: 'note.md', expected_revision: 'a'.repeat(40),
      content: 'saved by browser', profile: 'study-guide' }, token: 'Bearer session-only-token' });
    await panel.getByRole('button', { name: '编辑文件' }).click();
    await draft.fill('conflicting draft');
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.getByRole('alert')).toContainText('远端文件已更新');
    await expect(draft).toHaveValue('conflicting draft');
    expect(writes[1].body.expected_revision).toBe('b'.repeat(40));
    await expect(panel.getByRole('button', { name: '刷新' })).toBeDisabled();
    await page.getByRole('button', { name: '资料夹', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导', exact: true }).click();
    await expect(draft).toHaveValue('conflicting draft');
    await expect(panel.getByRole('button', { name: '查看文件' })).toBeDisabled();
    expect(await page.evaluate(() => JSON.stringify(sessionStorage) + JSON.stringify(localStorage))).not.toContain('conflicting draft');
  });

  test('saves a legacy-size Markdown note and retains drafts exceeding the Git limit', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'session-only-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const writes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().url().endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: ['large.md'], revision: 'a'.repeat(40) }) });
      if (route.request().method() === 'PATCH') {
        writes.push(route.request().postDataJSON());
        return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', path: 'large.md', revision: 'b'.repeat(40) }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', path: 'large.md', content: 'old', revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'large.md' }).click();
    await panel.getByRole('button', { name: '编辑文件' }).click();
    const draft = panel.getByRole('textbox', { name: '沙箱文件内容' });
    const large = 'a'.repeat(80 << 10);
    await draft.fill(large);
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.locator('pre')).toHaveText(large);
    expect(writes).toHaveLength(1);
    expect(writes[0].content).toBe(large);
    await panel.getByRole('button', { name: '编辑文件' }).click();
    await draft.fill(`${large}x`);
    await panel.getByRole('button', { name: '保存到 Git' }).click();
    await expect(panel.getByRole('alert')).toContainText('笔记超过 80 KiB');
    await expect(draft).toHaveValue(`${large}x`);
    expect(writes).toHaveLength(1);
  });

  test('creates a root Markdown note against the listed Git revision without overwriting an existing path', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'session-only-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const writes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PUT, PATCH, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().url().endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: [], revision: 'a'.repeat(40) }) });
      writes.push({ method: route.request().method(), body: route.request().postDataJSON() });
      if (writes.length === 1) return route.fulfill({ status: 409, contentType: 'application/json', headers,
        body: JSON.stringify({ error: 'note_conflict' }) });
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', path: 'new.md', revision: 'b'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    const filename = panel.getByRole('textbox', { name: '新文件名' });
    await filename.fill('new.md');
    await panel.getByRole('button', { name: '新建 Markdown' }).click();
    await expect(panel.getByRole('alert')).toContainText('远端文件已更新');
    await expect(filename).toHaveValue('new.md');
    await panel.getByRole('button', { name: '新建 Markdown' }).click();
    await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toBeVisible();
    await expect(filename).toHaveValue('');
    expect(writes).toEqual([1, 2].map(() => ({ method: 'PUT', body: {
      version: 'session.v1', owner_id: syntheticSessionA.id, session_id: sessionA.id,
      entry_id: guideA.id, profile: 'study-guide', path: 'new.md',
      expected_revision: 'a'.repeat(40), content: '',
    } })));
    await filename.fill('new.md');
    await panel.getByRole('button', { name: '新建 Markdown' }).click();
    await expect(panel.getByRole('alert')).toContainText('请填写一个尚不存在');
    expect(writes).toHaveLength(2);
  });

  for (const [remoteContent, recovered] of [['', true], ['another device created this', false]]) {
    test(`${recovered ? 'reconciles' : 'rejects'} an uncertain Git note creation without blindly retrying`, async ({ page }) => {
      await mockWorkspace(page, defaultState());
      await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
        json(route, 200, { token: 'workspace-token', expires_at: '2099-01-01T00:00:00Z',
          gateway_url: 'https://sandbox.example.invalid' }));
      let writes = 0;
      let reads = 0;
      await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        if (route.request().url().endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', paths: [], revision: 'a'.repeat(40) }) });
        if (route.request().method() === 'PUT') {
          writes++;
          expect(route.request().postDataJSON()).toMatchObject({
            path: 'uncertain.md', expected_revision: 'a'.repeat(40), content: '',
          });
          return route.abort('failed');
        }
        reads++;
        expect(route.request().method()).toBe('POST');
        return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', path: 'uncertain.md',
            content: remoteContent, revision: 'b'.repeat(40) }) });
      });
      await page.goto('/workspace');
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.getByRole('button', { name: '新手向导' }).click();
      const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
      await panel.getByRole('button', { name: '查看文件' }).click();
      await panel.getByRole('textbox', { name: '新文件名' }).fill('uncertain.md');
      await panel.getByRole('button', { name: '新建 Markdown' }).click();
      if (recovered) {
        await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toBeVisible();
        await expect(panel.getByRole('textbox', { name: '新文件名' })).toHaveValue('');
        await expect(panel.getByRole('alert')).toHaveCount(0);
      } else {
        await expect(panel.getByRole('alert')).toContainText('新建结果未确认');
        await expect(panel.getByRole('textbox', { name: '新文件名' })).toHaveValue('uncertain.md');
        await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toHaveCount(0);
      }
      expect(writes).toBe(1);
      expect(reads).toBe(1);
    });
  }

  test('conditionally removes a Git Markdown file after confirmation and retains it on conflict', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'session-only-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const deletes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      if (route.request().method() === 'DELETE') {
        deletes.push({ body: route.request().postDataJSON(), token: route.request().headers().authorization });
        return route.fulfill({ status: deletes.length === 1 ? 409 : 200, contentType: 'application/json', headers,
          body: JSON.stringify(deletes.length === 1 ? { error: 'note_conflict' } :
            { version: 'session.v1', path: 'note.md', revision: 'b'.repeat(40) }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify(route.request().url().endsWith('/notes')
          ? { version: 'session.v1', paths: ['note.md'], revision: 'a'.repeat(40) }
          : { version: 'session.v1', path: 'note.md', content: 'must remain until commit',
            revision: 'a'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('button', { name: 'note.md' }).click();
    page.once('dialog', dialog => dialog.dismiss());
    await panel.getByRole('button', { name: '移除' }).click();
    expect(deletes).toHaveLength(0);
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: '移除' }).click();
    await expect(panel.getByRole('alert')).toContainText('远端文件已更新');
    await expect(panel.locator('pre')).toHaveText('must remain until commit');
    page.once('dialog', dialog => dialog.accept());
    await panel.getByRole('button', { name: '移除' }).click();
    await expect(panel.getByRole('button', { name: 'note.md' })).toHaveCount(0);
    expect(deletes).toEqual([1, 2].map(() => ({
      body: { version: 'session.v1', owner_id: syntheticSessionA.id, session_id: sessionA.id,
        entry_id: guideA.id, profile: 'study-guide', path: 'note.md', expected_revision: 'a'.repeat(40) },
      token: 'Bearer session-only-token',
    })));
  });

  test('creates nested Markdown and moves it to a new Git directory without proxying note content', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'session-only-token', expires_at: '2099-01-01T00:00:00Z',
        gateway_url: 'https://sandbox.example.invalid' }));
    const writes = [];
    await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Allow-Methods': 'POST, PUT, OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
      const path = new URL(route.request().url()).pathname;
      if (path.endsWith('/notes')) return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify({ version: 'session.v1', paths: [], revision: 'a'.repeat(40) }) });
      writes.push({ path, method: route.request().method(), body: route.request().postDataJSON() });
      return route.fulfill({ status: 200, contentType: 'application/json', headers,
        body: JSON.stringify(path.endsWith('/move')
          ? { version: 'session.v1', path: 'topics/new.md', destination: 'archive/renamed.md', revision: 'c'.repeat(40) }
          : { version: 'session.v1', path: 'topics/new.md', revision: 'b'.repeat(40) }) });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await panel.getByRole('textbox', { name: '新文件名' }).fill('topics/new.md');
    await panel.getByRole('button', { name: '新建 Markdown' }).click();
    await expect(panel.getByRole('textbox', { name: '沙箱文件内容' })).toBeVisible();
    await panel.getByRole('button', { name: '取消' }).click();
    await panel.getByRole('textbox', { name: '重命名或移动到路径' }).fill('archive/renamed.md');
    await panel.getByRole('button', { name: '重命名/移动' }).click();
    await expect(panel.locator('.sandbox-notes-preview-heading')).toContainText('archive/renamed.md');
    await expect(panel.getByRole('button', { name: 'topics/new.md' })).toHaveCount(0);
    expect(writes).toEqual([
      { path: '/v1/sessions/note', method: 'PUT',
        body: { version: 'session.v1', owner_id: syntheticSessionA.id, session_id: sessionA.id,
          entry_id: guideA.id, profile: 'study-guide', path: 'topics/new.md', expected_revision: 'a'.repeat(40), content: '' } },
      { path: '/v1/sessions/note/move', method: 'POST',
        body: { version: 'session.v1', owner_id: syntheticSessionA.id, session_id: sessionA.id,
          entry_id: guideA.id, profile: 'study-guide', path: 'topics/new.md',
          destination: 'archive/renamed.md', expected_revision: 'b'.repeat(40) } },
    ]);
  });

  for (const recovered of [true, false]) {
    test(`${recovered ? 'confirms' : 'preserves'} an uncertain Git note move after a lost response`, async ({ page }) => {
      await mockWorkspace(page, defaultState());
      await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
        json(route, 200, { token: 'workspace-token', expires_at: '2099-01-01T00:00:00Z',
          gateway_url: 'https://sandbox.example.invalid' }));
      let writes = 0;
      let reads = 0;
      let revision = 'a'.repeat(40);
      await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/note/move')) {
          writes++;
          expect(route.request().postDataJSON()).toMatchObject({
            path: 'source.md', destination: 'archive/moved.md', expected_revision: 'a'.repeat(40),
          });
          revision = 'b'.repeat(40);
          return route.fulfill({ status: 503, contentType: 'application/json', headers, body: '{}' });
        }
        if (url.pathname.endsWith('/notes')) {
          reads++;
          return route.fulfill({ status: 200, contentType: 'application/json', headers,
            body: JSON.stringify({ version: 'session.v1', paths: recovered && writes ? ['archive/moved.md'] : ['source.md'], revision }) });
        }
        const path = route.request().postDataJSON().path;
        reads++;
        return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', path, content: 'original body', revision }) });
      });
      await page.goto('/workspace');
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.getByRole('button', { name: '新手向导' }).click();
      const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
      await panel.getByRole('button', { name: '查看文件' }).click();
      await panel.getByRole('button', { name: 'source.md' }).click();
      await panel.getByRole('textbox', { name: '重命名或移动到路径' }).fill('archive/moved.md');
      await panel.getByRole('button', { name: '重命名/移动' }).click();
      if (recovered) {
        await expect(panel.locator('.sandbox-notes-preview-heading')).toContainText('archive/moved.md');
        await expect(panel.getByRole('alert')).toHaveCount(0);
        expect(reads).toBe(4);
      } else {
        await expect(panel.getByRole('alert')).toContainText('移动结果未确认');
        await expect(panel.locator('.sandbox-notes-preview-heading')).toContainText('source.md');
        expect(reads).toBe(3);
      }
      expect(writes).toBe(1);
    });

    test(`${recovered ? 'confirms' : 'preserves'} an uncertain Git note deletion after a lost response`, async ({ page }) => {
      await mockWorkspace(page, defaultState());
      await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
        json(route, 200, { token: 'workspace-token', expires_at: '2099-01-01T00:00:00Z',
          gateway_url: 'https://sandbox.example.invalid' }));
      let writes = 0;
      let lists = 0;
      let revision = 'a'.repeat(40);
      await page.route('https://sandbox.example.invalid/v1/sessions/**', route => {
        const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS' };
        if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
        const url = new URL(route.request().url());
        if (route.request().method() === 'DELETE') {
          writes++;
          expect(route.request().postDataJSON()).toMatchObject({ path: 'source.md', expected_revision: 'a'.repeat(40) });
          revision = 'b'.repeat(40);
          return route.fulfill({ status: 503, contentType: 'application/json', headers, body: '{}' });
        }
        if (url.pathname.endsWith('/notes')) {
          lists++;
          return route.fulfill({ status: 200, contentType: 'application/json', headers,
            body: JSON.stringify({ version: 'session.v1', paths: recovered ? writes ? [] : ['source.md'] : ['source.md'], revision }) });
        }
        return route.fulfill({ status: 200, contentType: 'application/json', headers,
          body: JSON.stringify({ version: 'session.v1', path: 'source.md', content: 'original body', revision }) });
      });
      await page.goto('/workspace');
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      await page.getByRole('button', { name: '新手向导' }).click();
      const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
      await panel.getByRole('button', { name: '查看文件' }).click();
      await panel.getByRole('button', { name: 'source.md' }).click();
      page.once('dialog', dialog => dialog.accept());
      await panel.getByRole('button', { name: '移除' }).click();
      if (recovered) {
        await expect(panel.getByRole('button', { name: 'source.md' })).toHaveCount(0);
        await expect(panel.getByRole('alert')).toHaveCount(0);
      } else {
        await expect(panel.getByRole('alert')).toContainText('删除结果未确认');
        await expect(panel.getByRole('button', { name: 'source.md' })).toBeVisible();
      }
      expect(writes).toBe(1);
      expect(lists).toBe(2);
    });
  }

  test('reports an unavailable direct sandbox endpoint instead of falling back to legacy notes', async ({ page }) => {
    await mockWorkspace(page, defaultState());
    await page.route(`**/api/sessions/${sessionA.id}/sandbox-token`, route =>
      json(route, 200, { token: 'short-lived-session-token', expires_at: '2099-01-01T00:00:00Z' }));
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const panel = page.getByRole('region', { name: 'Agent Git 工作区' });
    await panel.getByRole('button', { name: '查看文件' }).click();
    await expect(panel.getByRole('alert')).toContainText('沙箱直连入口尚未配置');
  });

  test('restores an unconfirmed Agent request after reload without changing its identity', async ({ page }) => {
    const state = defaultState();
    state.sendError = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await composer.fill('请解释主动回忆');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('草稿已保留');
    const requestId = state.sentRequests[0].client_request_id;
    expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${id}`)), sessionA.id))
      .toEqual({ sessionId: sessionA.id, id: requestId, digest: expect.stringMatching(/^[0-9a-f]{64}$/) });
    await composer.fill('改成另一个问题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('不能用新内容覆盖');
    expect(state.sentRequests).toHaveLength(1);

    await page.reload();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('alert')).toContainText('重新输入原消息');

    await composer.fill('改成另一个问题');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('不能用新内容覆盖');
    expect(state.sentRequests).toHaveLength(1);

    await composer.fill('请解释主动回忆');
    state.sendError = false;
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.locator('.chat-message.assistant')).toContainText('已收到');
    expect(state.sentRequests.map(item => item.client_request_id)).toEqual([requestId, requestId]);
    await page.reload();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(composer).toHaveValue('');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.locator('.chat-message.assistant')).toContainText('已收到');
  });

  test('recovers a completed Agent turn when its POST response is lost', async ({ page }) => {
    const state = defaultState();
    state.dropReply = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
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
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
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
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    await expect(page.locator('.chat-message.user').first()).toContainText('总结课程');
    await expect(page.locator('.chat-message.assistant').first()).toContainText('已收到');
    await expect(page.getByRole('alert')).toHaveCount(0);
    expect(state.sentRequests).toHaveLength(2);
    expect(await page.evaluate(id => sessionStorage.getItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${id}`), sessionA.id)).toBeNull();
  });

  test('keeps the draft when a server turn reuses the request id with different content', async ({ page }) => {
    const state = defaultState();
    state.sendError = true;
    await mockWorkspace(page, state);
    await page.goto('/workspace');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.getByRole('button', { name: '新手向导' }).click();
    const composer = page.getByRole('textbox', { name: '发送给 Agent 的消息' });
    await composer.fill('原始消息');
    await page.getByRole('button', { name: '发送', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('发送结果未确认');
    const requestId = state.sentRequests[0].client_request_id;
    state.sessionById[sessionA.id] = { ...sessionA, messages: [
      { role: 'user', content: '不同的内容', client_request_id: requestId, created_at: '2026-01-01T00:00:10.000Z' },
      { role: 'assistant', content: '不应被确认', created_at: '2026-01-01T00:00:11.000Z' },
    ] };
    await page.getByRole('button', { name: '确认发送结果' }).click();
    await expect(page.getByRole('alert')).toContainText('服务器记录与原消息不一致');
    await expect(composer).toHaveValue('原始消息');
    expect(state.sentRequests).toHaveLength(1);
    expect(await page.evaluate(id => JSON.parse(sessionStorage.getItem(`tjuclaw.chat.pending.v1.user-identity-uuid-aaaa.${id}`)).id, sessionA.id)).toBe(requestId);
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
    await expect(page.locator('.anki-browser-front strong')).toHaveText('问题');
    await expect(page.locator('.anki-title-block p')).toHaveText('考前复习');
    expect(imports).toBe(1);
    expect(individualCreates).toBe(0);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-sidebar-deck').filter({ hasText: '考前复习' }).click();
    await expect(page.locator('.anki-review-card')).toContainText('问题');
    await expect(page.locator('.anki-title-block p')).toHaveText('考前复习');
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
    await expect(page.locator('.anki-browser-front strong')).toHaveText('<img src=x onerror=alert(1)>');
    await page.locator('.anki-sidebar-deck').click();
    await page.locator('.anki-review-card').click();
    await expect(page.locator('.anki-review-card img')).toHaveCount(0);
    await page.getByRole('button', { name: /良好/ }).click();
    await expect.poll(() => reviews).toBe(1);
    await expect(page.getByText('还没有学习记录')).toHaveCount(0);
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await expect(page.locator('.anki-browser-row .is-review')).toHaveCount(1);
    await page.getByRole('button', { name: '查看学习概览' }).click();
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
    await page.getByRole('button', { name: '查看学习概览' }).click();
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
    await expect(page.locator('.anki-title-block p')).toHaveText('考前复习');
    const created = owner.decks.find(deck => deck.id !== defaultDeck.id);
    expect(created?.name).toBe('考前复习');
    await page.getByRole('button', { name: '新建卡片' }).click();
    await page.getByRole('textbox', { name: '正面' }).fill('第二牌组的卡片');
    await expect.poll(() => owner.cards.find(card => card.deck_id === created.id)?.front).toBe('第二牌组的卡片');
    page.once('dialog', dialog => dialog.accept('期末复习'));
    await page.getByRole('button', { name: '重命名牌组 考前复习' }).click();
    await expect(page.locator('.anki-title-block p')).toHaveText('期末复习');
    await page.reload();
    await page.getByRole('button', { name: '记忆闪卡', exact: true }).click();
    await page.locator('.anki-sidebar-deck').filter({ hasText: '期末复习' }).click();
    await expect(page.locator('.anki-review-card')).toContainText('第二牌组的卡片');
    await page.getByRole('button', { name: '退出学习' }).click();
    await page.getByRole('button', { name: '浏览卡片' }).click();
    await expect(page.locator('.anki-browser-front strong')).toHaveText('第二牌组的卡片');
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '删除牌组 期末复习' }).click();
    await expect(page.locator('.anki-title-block p')).toHaveText(defaultDeck.name);
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
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: '新手向导', exact: true })).toBeVisible();
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
    await page.locator('.sidebar-activity').getByRole('button', { name: '资料夹', exact: true }).click();
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
  await page.getByRole('button', { name: '关闭操作菜单' }).click({ position: { x: 24, y: 24 } });
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
    const active = menu.getByRole('button', { name: '加粗' });
    const next = menu.getByRole('button', { name: '斜体' });
    const activeColor = await active.evaluate(element => getComputedStyle(element).backgroundColor);
    await expect.poll(async () => {
      const activeBounds = await active.boundingBox();
      const nextBounds = await next.boundingBox();
      return nextBounds.y - activeBounds.y - activeBounds.height;
    }).toBe(2);
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

test('Agent without a sandbox offers campus starters and shows which tools a reply used', async ({ page }) => {
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
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  await expect(page.getByPlaceholder('搜索 Agent…')).toBeVisible();
  await page.getByText('新手向导').first().click();
  await expect(page.getByRole('region', { name: 'Agent Git 工作区' })).toHaveCount(0);
  const log = page.getByRole('log', { name: '会话记录' });
  await expect(log.getByText('校园服务', { exact: true })).toBeVisible();
  await expect(log.getByText('课程资料', { exact: true })).toBeVisible();
  await log.getByRole('button', { name: '看看我明天下午什么时候有空' }).click();
  await expect(page.getByLabel('发送给 Agent 的消息')).toHaveValue('看看我明天下午什么时候有空');
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await expect(log.getByText('明天 14:00 以后没有课。')).toBeVisible();
  await expect(log.getByText('使用了 学期 · 课表')).toBeVisible();
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
  await expect(page.getByRole('dialog').getByText('0 条双向链接')).toHaveCount(0);
  unavailable = false;
  await page.getByRole('button', { name: '重试加载' }).click();
  await expect(page.getByRole('dialog').getByText('2 篇笔记 · 1 条双向链接')).toBeVisible();
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
  await page.getByRole('button', { name: '知识图谱' }).click();
  await expect(page.getByRole('dialog').getByRole('heading', { name: '知识图谱' })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
});

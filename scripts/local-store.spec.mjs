import { expect, test } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const open = page => page.evaluate(async () => {
  const module = await import('/src/lib/local-store.ts');
  window.__store = await module.openLocalStore();
  window.__module = module;
  return window.__store.engine;
});

test('browser tabs share one SQLite database on OPFS and survive leader handover', async ({ context }) => {
  const first = await context.newPage();
  await first.goto('/preview/appearance');
  expect(await open(first)).toBe('sqlite-opfs');
  await first.evaluate(async () => {
    await window.__store.set('notes', 'b', '第二条');
    await window.__store.set('notes', 'a', '第一条');
    await window.__store.set('other', 'a', 'x');
  });

  const second = await context.newPage();
  await second.goto('/preview/appearance');
  expect(await open(second)).toBe('sqlite-opfs');
  expect(await second.evaluate(() => window.__store.list('notes'))).toEqual([['a', '第一条'], ['b', '第二条']]);
  await second.evaluate(() => window.__store.set('notes', 'c', '来自第二个标签页'));
  expect(await first.evaluate(() => window.__store.get('notes', 'c'))).toBe('来自第二个标签页');

  // Closing the leader hands the database to the remaining tab.
  await first.close();
  await expect.poll(() => second.evaluate(() => window.__store.get('notes', 'a')), { timeout: 15_000 }).toBe('第一条');
  await second.evaluate(() => window.__store.delete('notes', 'a'));
  expect(await second.evaluate(() => window.__store.get('notes', 'a'))).toBeNull();

  // Data persists across a reload.
  await second.reload();
  expect(await open(second)).toBe('sqlite-opfs');
  expect(await second.evaluate(() => window.__store.list('notes'))).toEqual([['b', '第二条'], ['c', '来自第二个标签页']]);
});

test('legacy localStorage keys migrate once without overwriting newer values', async ({ page }) => {
  await page.goto('/preview/appearance');
  await open(page);
  const result = await page.evaluate(async () => {
    localStorage.setItem('tjuclaw.appearance.v1', '{"mode":"dark"}');
    const first = await window.__module.importLegacyLocalStorage(window.__store, 'prefs', ['tjuclaw.appearance.v1', 'missing']);
    await window.__store.set('prefs', 'tjuclaw.appearance.v1', '{"mode":"light"}');
    const second = await window.__module.importLegacyLocalStorage(window.__store, 'prefs', ['tjuclaw.appearance.v1']);
    return [first, second, await window.__store.get('prefs', 'tjuclaw.appearance.v1')];
  });
  expect(result).toEqual([1, 0, '{"mode":"light"}']);
});

test('invalid names and oversized values are rejected before storage', async ({ page }) => {
  await page.goto('/preview/appearance');
  await open(page);
  const errors = await page.evaluate(async () => {
    const attempt = promise => promise.then(() => 'ok', error => error.message);
    return [
      await attempt(window.__store.set('', 'k', 'v')),
      await attempt(window.__store.get('ns', 'x'.repeat(257))),
      await attempt(window.__store.set('ns', 'k', 'x'.repeat((4 << 20) + 1))),
    ];
  });
  expect(errors).toEqual(['store_invalid_key', 'store_invalid_key', 'store_value_too_large']);
});

test('a Git replica syncs into SQLite on OPFS, reads offline and survives a reload', async ({ page }) => {
  // A real repository answers the browser through `git upload-pack`, as a Git host does.
  const root = mkdtempSync(join(tmpdir(), 'tjuclaw-git-opfs-'));
  const repo = join(root, 'workspace');
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env }).toString().trim();
  const commit = (message, path, content) => {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
    git('add', '-A');
    git('commit', '-q', '-m', message);
    return git('rev-parse', 'HEAD');
  };
  try {
    mkdirSync(repo, { recursive: true });
    git('init', '-q', '-b', 'main');
    commit('导入', 'notes/我的知识库/电路.md', '# 电路\n');
    const first = commit('补充', 'notes/我的知识库/电路.md', '# 电路\n\n基尔霍夫定律。\n');
    let requests = 0;
    await page.exposeFunction('gitUploadPack', base64 => {
      requests++;
      const result = spawnSync('git', ['upload-pack', '--stateless-rpc', repo],
        { env: { ...env, GIT_PROTOCOL: 'version=2' }, input: Buffer.from(base64, 'base64'), maxBuffer: 64 << 20 });
      return result.stdout.toString('base64');
    });
    const sync = () => page.evaluate(async () => {
      const [{ openGitStore }, replica] = await Promise.all([import('/src/lib/git/sqlite-store.ts'), import('/src/lib/git/repo.ts')]);
      const store = await openGitStore('test-owner/workspace');
      const transport = async body => {
        const reply = await window.gitUploadPack(btoa(String.fromCharCode(...body)));
        return Uint8Array.from(atob(reply), char => char.charCodeAt(0));
      };
      const result = await replica.syncRepo(store, transport);
      const head = await replica.readCommit(store, result.head);
      const files = await replica.listFiles(store, head.tree);
      const path = 'notes/我的知识库/电路.md';
      return { ...result, paths: [...files.keys()], text: await replica.readText(store, files.get(path)),
        history: (await replica.fileHistory(store, result.head, path)).map(item => item.message.trim()) };
    });
    // Reads from the stored replica only; nothing is asked of the remote.
    const offline = () => page.evaluate(async () => {
      const [{ openGitStore }, replica] = await Promise.all([import('/src/lib/git/sqlite-store.ts'), import('/src/lib/git/repo.ts')]);
      const store = await openGitStore('test-owner/workspace');
      const head = await store.getRef('refs/heads/main');
      const files = await replica.listFiles(store, (await replica.readCommit(store, head)).tree);
      return { head, text: await replica.readText(store, files.get('notes/我的知识库/电路.md')),
        other: await (await openGitStore('someone-else/workspace')).getRef('refs/heads/main') };
    });

    await page.goto('/preview/appearance');
    expect(await sync()).toMatchObject({ head: first, changed: true, objects: 10, paths: ['notes/我的知识库/电路.md'],
      text: '# 电路\n\n基尔霍夫定律。\n', history: ['补充', '导入'] });

    await page.reload();
    const before = requests;
    expect(await offline()).toEqual({ head: first, text: '# 电路\n\n基尔霍夫定律。\n', other: null });
    expect(requests).toBe(before);

    const second = commit('再补充', 'notes/我的知识库/电路.md', '# 电路\n\n基尔霍夫定律与戴维南定理。\n');
    expect(await sync()).toMatchObject({ head: second, changed: true, objects: 5, history: ['再补充', '补充', '导入'] });
    expect(await sync()).toMatchObject({ head: second, changed: false, objects: 0 });

    // Clearing one repository removes its objects and refs, as signing out must.
    expect(await page.evaluate(async () => {
      const { openGitStore } = await import('/src/lib/git/sqlite-store.ts');
      const store = await openGitStore('test-owner/workspace');
      const head = await store.getRef('refs/heads/main');
      await store.clear();
      return [await store.getRef('refs/heads/main'), await store.read(head)];
    })).toEqual([null, null]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

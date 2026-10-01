import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { parsePack } from '../src/lib/git/pack.ts';
import { fetchPack, httpTransport, listRefs } from '../src/lib/git/protocol.ts';
import { fileHistory, listFiles, readCommit, readText, syncRepo } from '../src/lib/git/repo.ts';
import { memoryStore } from '../src/lib/git/store.ts';

// The replica is checked against the real Git: a repository built with the
// git CLI is served through `git upload-pack` exactly as a Git host serves it.
const root = mkdtempSync(join(tmpdir(), 'tjuclaw-git-replica-'));
const repo = join(root, 'workspace');
const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: '测试', GIT_AUTHOR_EMAIL: 'test@example.invalid', GIT_COMMITTER_NAME: '测试', GIT_COMMITTER_EMAIL: 'test@example.invalid' };
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { env, maxBuffer: 64 << 20 });
const commit = (message, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(repo, path, '..'), { recursive: true });
    writeFileSync(join(repo, path), content);
  }
  git('add', '-A');
  git('commit', '-q', '-m', message);
  return git('rev-parse', 'HEAD').toString().trim();
};
const long = Array.from({ length: 4000 }, (_, index) => `第 ${index} 行：基尔霍夫电流定律与节点分析。`).join('\n');
let server, transport, requests = 0;

before(async () => {
  mkdirSync(repo, { recursive: true });
  git('init', '-q', '-b', 'main');
  commit('导入笔记', { 'notes/我的知识库/电路.md': long, 'notes/我的知识库/复习/期末.md': '# 期末\n', 'README.md': 'workspace\n' });
  commit('修改一行', { 'notes/我的知识库/电路.md': long.replace('第 2000 行', '第 2000 行（已修订）') });
  commit('再改一行', { 'notes/我的知识库/电路.md': long.replace('第 2000 行', '第 2000 行（二次修订）') });
  // Store the similar revisions as deltas, as a long-lived remote does.
  git('repack', '-a', '-d', '-f', '-q', '--depth=20', '--window=20');
  server = createServer((request, response) => {
    if (request.method !== 'POST' || request.url !== '/workspace.git/git-upload-pack' || request.headers['git-protocol'] !== 'version=2') {
      response.writeHead(400).end();
      return;
    }
    requests++;
    const child = spawn('git', ['upload-pack', '--stateless-rpc', repo], { env: { ...env, GIT_PROTOCOL: 'version=2' } });
    request.pipe(child.stdin);
    response.writeHead(200, { 'Content-Type': 'application/x-git-upload-pack-result' });
    child.stdout.pipe(response);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  transport = httpTransport(`http://127.0.0.1:${server.address().port}/workspace.git/`);
});

after(() => {
  server?.close();
  rmSync(root, { recursive: true, force: true });
});

test('a first sync stores every object exactly as Git has it', async () => {
  const store = memoryStore();
  const head = git('rev-parse', 'HEAD').toString().trim();
  const result = await syncRepo(store, transport);
  assert.equal(result.head, head);
  assert.equal(result.changed, true);
  assert.equal(await store.getRef('refs/heads/main'), head);

  const listed = git('rev-list', '--objects', '--all').toString().trim().split('\n').map(line => line.split(' ')[0]);
  assert.equal(result.objects, listed.length);
  assert.equal(store.size(), listed.length);
  for (const oid of listed) {
    const type = git('cat-file', '-t', oid).toString().trim();
    const object = await store.read(oid);
    assert.equal(object?.type, type, oid);
    assert.deepEqual(Buffer.from(object.data), git('cat-file', type, oid), oid);
  }
  // The three revisions of one long note travel as deltas, not three full copies.
  assert.ok(result.packBytes < Buffer.byteLength(long), `pack is ${result.packBytes} bytes`);
});

test('the stored tree and history answer without the network', async () => {
  const store = memoryStore();
  const { head } = await syncRepo(store, transport);
  const before = requests;
  const commitInfo = await readCommit(store, head);
  assert.equal(commitInfo.message, '再改一行\n');
  assert.equal(commitInfo.author, '测试');
  assert.equal(commitInfo.parents.length, 1);

  const files = await listFiles(store, commitInfo.tree);
  const expected = git('ls-tree', '-r', '-z', '--name-only', 'HEAD').toString().split('\0').filter(Boolean);
  assert.deepEqual([...files.keys()].sort(), expected.sort());
  assert.match(await readText(store, files.get('notes/我的知识库/电路.md')), /第 2000 行（二次修订）/);
  assert.equal(await readText(store, files.get('notes/我的知识库/复习/期末.md')), '# 期末\n');

  const history = await fileHistory(store, head, 'notes/我的知识库/电路.md');
  assert.deepEqual(history.map(item => item.oid),
    git('log', '--format=%H', '--', 'notes/我的知识库/电路.md').toString().trim().split('\n'));
  assert.equal((await fileHistory(store, head, 'README.md')).length, 1);
  assert.equal((await fileHistory(store, head, 'missing.md')).length, 0);
  assert.equal(requests, before, 'reads must not touch the remote');
});

test('a later sync downloads only what is new, and an unchanged remote downloads nothing', async () => {
  const store = memoryStore();
  const first = await syncRepo(store, transport);
  const idle = requests;
  assert.deepEqual(await syncRepo(store, transport), { head: first.head, changed: false, objects: 0, packBytes: 0 });
  assert.equal(requests, idle + 1, 'an unchanged remote costs one ref listing');

  const head = commit('新增一篇', { 'notes/我的知识库/信号.md': '# 信号与系统\n' });
  const second = await syncRepo(store, transport);
  assert.equal(second.head, head);
  assert.equal(second.changed, true);
  // One commit, the three trees on its path and one blob.
  assert.equal(second.objects, 5);
  assert.ok(second.packBytes < first.packBytes / 4, `incremental pack is ${second.packBytes} of ${first.packBytes} bytes`);
  const files = await listFiles(store, (await readCommit(store, head)).tree);
  assert.equal(await readText(store, files.get('notes/我的知识库/信号.md')), '# 信号与系统\n');
  assert.equal((await fileHistory(store, head, 'notes/我的知识库/电路.md')).length, 3);
});

test('a damaged or truncated pack is refused and leaves the replica untouched', async () => {
  const refs = await listRefs(transport);
  const pack = await fetchPack(transport, [refs.get('refs/heads/main')]);
  const flipped = Uint8Array.from(pack);
  flipped[Math.floor(pack.length / 2)] ^= 0xff;
  await assert.rejects(parsePack(flipped), /git_pack_corrupt/);
  await assert.rejects(parsePack(pack.subarray(0, pack.length - 7)), /git_pack_corrupt/);
  await assert.rejects(parsePack(new Uint8Array(40)), /git_pack_invalid/);

  const store = memoryStore();
  const broken = async body => {
    const response = await transport(body);
    // Corrupt only pack responses; ref listings are short.
    if (response.length > 2000) response[response.length - 30] ^= 0xff;
    return response;
  };
  await assert.rejects(syncRepo(store, broken), /git_pack_corrupt/);
  assert.equal(await store.getRef('refs/heads/main'), null);
  assert.equal(store.size(), 0);
});

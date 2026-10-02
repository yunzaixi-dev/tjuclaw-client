import assert from 'node:assert/strict';
import test from 'node:test';
import { formatTokenRate, inputPreview, mergeTimeline, stageText, timelineCursor } from '../src/lib/live-stream.ts';
import { matchingCommands, slashQuery } from '../src/lib/pi-commands.ts';

const entry = (i, kind, patch = {}) => ({
  i, kind, text: '', from: 0, next: 0, name: '', input: '', status: 'running', lines: 0, added: 0, removed: 0, output: '', ...patch,
});
const poll = (version, count, ...items) => ({ version, count, items });

test('the timeline grows in order and a continued text is appended where it stopped', () => {
  const first = mergeTimeline([], poll(1, 2, entry(0, 'thinking', { text: '先看', next: 6 }), entry(1, 'tool', { name: 'write', status: 'writing', lines: 12 })));
  assert.equal(first.resync, false);
  assert.deepEqual(first.items.map(item => item.kind), ['thinking', 'tool']);
  // Only what changed arrives: the tool has run, and the model writes again.
  const second = mergeTimeline(first.items, poll(2, 3, entry(1, 'tool', { name: 'write', status: 'done', added: 30 }), entry(2, 'text', { text: '写好', next: 6 })));
  assert.equal(second.items[0].text, '先看');
  assert.deepEqual([second.items[1].status, second.items[1].added, second.items[1].lines], ['done', 30, 0]);
  const third = mergeTimeline(second.items, poll(3, 3, entry(2, 'text', { text: '了。', from: 6, next: 12 })));
  assert.equal(third.items[2].text, '写好了。');
  assert.equal(third.items[2].next, 12);
  assert.equal(third.resync, false);
});

test('an idle or unversioned poll never blanks what is on screen', () => {
  const shown = mergeTimeline([], poll(4, 2, entry(0, 'tool', { name: 'campus_exams' }), entry(1, 'text', { text: '基尔霍夫', next: 12 }))).items;
  for (const version of [0, null]) {
    const kept = mergeTimeline(shown, poll(version, 0));
    assert.equal(kept.items, shown);
    assert.equal(kept.resync, false);
  }
});

test('a poll that cannot be joined to the screen asks for the whole timeline', () => {
  const shown = mergeTimeline([], poll(1, 2, entry(0, 'thinking', { text: '先', next: 3 }), entry(1, 'text', { text: '答', next: 3 }))).items;
  // A continuation that starts elsewhere, an entry past the end, and a shorter timeline.
  assert.equal(mergeTimeline(shown, poll(2, 2, entry(1, 'text', { text: '案', from: 9, next: 12 }))).resync, true);
  assert.equal(mergeTimeline(shown, poll(2, 4, entry(3, 'tool', { name: 'bash' }))).resync, true);
  assert.equal(mergeTimeline(shown, poll(2, 1, entry(0, 'thinking', { text: '重来', next: 6 }))).resync, true);
  // The count says an entry is missing even when every received one fits.
  assert.equal(mergeTimeline(shown, poll(2, 3)).resync, true);
  for (const result of [mergeTimeline(shown, poll(2, 1)), mergeTimeline(shown, poll(2, 4, entry(3, 'tool')))]) assert.equal(result.items, shown);
});

test('the cursor follows the entry whose text can still grow', () => {
  const items = mergeTimeline([], poll(1, 2, entry(0, 'tool', { name: 'read', status: 'done' }), entry(1, 'text', { text: '答', next: 3 }))).items;
  assert.deepEqual(timelineCursor(7, items), { version: 7, tail: 1, at: 3 });
  // After a tool call nothing is growing: the tail points past the end.
  assert.deepEqual(timelineCursor(8, items.slice(0, 1)), { version: 8, tail: 1, at: 0 });
  assert.deepEqual(timelineCursor(1, []), { version: 1, tail: 0, at: 0 });
});

test('the speed waits until a rate is meaningful', () => {
  assert.equal(formatTokenRate(4, 200), '');
  assert.equal(formatTokenRate(0, 5000), '');
  assert.equal(formatTokenRate(8, 1000), '8.0 token/秒');
  assert.equal(formatTokenRate(24, 1000), '24 token/秒');
});

test('tool arguments collapse to one short line', () => {
  assert.equal(inputPreview('{"title":"电路复习","query":"KCL"}'), 'title: 电路复习 · query: KCL');
  assert.equal(inputPreview('ls -la /tmp'), 'ls -la /tmp');
  assert.equal(inputPreview('x'.repeat(60)).endsWith('…'), true);
});

test('a slash token opens Pi commands and a sentence does not', () => {
  assert.equal(slashQuery('/thi'), '/thi');
  assert.equal(slashQuery('/thinking'), '/thinking');
  assert.equal(slashQuery('/hello world'), null);
  assert.equal(slashQuery('你好'), null);
  assert.deepEqual(matchingCommands('/co').map(command => command.name), ['/copy']);
  assert.deepEqual(matchingCommands('/compact'), []);
  assert.deepEqual(matchingCommands('/').map(command => command.name), ['/new', '/model', '/thinking', '/copy', '/session', '/resume']);
});

test('the stage says what the turn is waiting for, and for how long', () => {
  assert.equal(stageText('connecting', 300, false), '正在连接云端');
  assert.equal(stageText('lease', 2500, false), '等待工作区空闲（已等 2 秒）');
  assert.equal(stageText('sandbox', 9400, false), '等待沙箱就绪（已等 9 秒）');
  assert.equal(stageText('agent', 1200, false), '正在启动 Pi');
  assert.equal(stageText('model', 4100, false), '等待模型回复（已等 4 秒）');
  // After a tool call Pi is already running.
  assert.equal(stageText('agent', 3000, true), 'Pi 正在整理工具结果（已等 3 秒）');
  // The model's own output is not a wait: no counter.
  assert.equal(stageText('thinking', 8000, false), '模型正在思考');
  assert.equal(stageText('writing', 8000, true), '正在回答');
  assert.equal(stageText('tool', 5000, true, '搜索笔记'), '正在搜索笔记');
  assert.equal(stageText('tool', 5000, true), '正在调用工具');
  assert.equal(stageText('preparing', 5000, true, '写入文件'), '正在准备写入文件');
  assert.equal(stageText('preparing', 5000, false), '正在准备调用工具');
  // An older server, or a stage this client does not know: the caller decides.
  assert.equal(stageText('', 5000, false), '');
  assert.equal(stageText('unknown', 5000, false), '');
  assert.equal(stageText('model', -50, false), '等待模型回复');
});

test('token allowances read in 万 and 亿, with the share left and a model\'s rate', async () => {
  const { formatTokens, formatQuotaUse, quotaShareLeft, formatModelRate } = await import('../src/lib/quota-format.ts');
  assert.equal(formatTokens(0), '0');
  assert.equal(formatTokens(9999), '9999');
  assert.equal(formatTokens(20_000_000), '2000 万');
  assert.equal(formatTokens(1_234_567), '123 万');
  assert.equal(formatTokens(56_000), '5.6 万');
  assert.equal(formatTokens(250_000_000), '2.5 亿');
  const week = { id: '7d', limit: 20_000_000, used: 3_400_000, remaining: 16_600_000, unit: 'tokens' };
  assert.equal(formatQuotaUse(week), '340 万 / 2000 万 tokens');
  assert.equal(quotaShareLeft(week), 83);
  assert.equal(quotaShareLeft({ ...week, remaining: 0 }), 0);
  // An older server counts turns and sends no unit.
  assert.equal(formatQuotaUse({ id: '5h', limit: 30, used: 4, remaining: 26 }), '4 / 30');
  assert.equal(formatModelRate(1), '');
  assert.equal(formatModelRate(undefined), '');
  assert.equal(formatModelRate(2.5), '2.5 倍额度');
  assert.equal(formatModelRate(0.5), '0.5 倍额度');
});

test('the greeting follows the hour', async () => {
  const { greeting } = await import('../src/lib/greeting.ts');
  const starts = hour => greeting(hour).slice(0, 3);
  assert.deepEqual([4, 5, 8, 9, 11, 12, 13, 14, 17, 18, 22, 23, 0].map(starts),
    ['夜深了', '早上好', '早上好', '上午好', '上午好', '中午好', '中午好', '下午好', '下午好', '晚上好', '晚上好', '夜深了', '夜深了']);
  for (let hour = 0; hour < 24; hour++) assert.match(greeting(hour), /？$/);
});

test('the animated conversation background is off unless it was chosen', async () => {
  globalThis.window = { matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }), addEventListener() {}, removeEventListener() {}, requestIdleCallback() {} };
  globalThis.document = { documentElement: { dataset: {}, style: {} }, querySelector: () => null };
  globalThis.localStorage = { getItem: () => null, setItem() {} };
  const { parseAppearance } = await import('../src/lib/appearance.ts');
  assert.equal(parseAppearance(null).life, false);
  assert.equal(parseAppearance('{"mode":"dark"}').life, false);
  assert.equal(parseAppearance('{"life":"yes"}').life, false);
  assert.equal(parseAppearance('{"life":true}').life, true);
});

test('an update summary is a few short single lines, and old manifests have none', async () => {
  const { summaryFromNotes, summaryLines } = await import('../src/lib/release-notes.ts');
  assert.deepEqual(summaryLines(['  会话可以\n重命名 ', '', 7, 'x'.repeat(200), '三', '四', '五']), ['会话可以 重命名', 'x'.repeat(79) + '…', '三', '四']);
  assert.deepEqual(summaryLines('not a list'), []);
  assert.deepEqual(summaryFromNotes('会话可以重命名\n界面更流畅'), ['会话可以重命名', '界面更流畅']);
  // The notes of releases before summaries only name the version.
  assert.deepEqual(summaryFromNotes('TJUClaw Client v0.0.47（源码提交 abcdef012345）'), []);
  assert.deepEqual(summaryFromNotes(undefined), []);
});

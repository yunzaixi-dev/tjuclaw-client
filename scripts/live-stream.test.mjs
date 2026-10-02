import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, formatTokenRate, inputPreview, mergeLiveFrame, stageText } from '../src/lib/live-stream.ts';
import { matchingCommands, slashQuery } from '../src/lib/pi-commands.ts';

const frame = (patch = {}) => ({
  version: 1, steps: [], call: '5', thinking: '', thinkingFrom: 0, text: '', textFrom: 0, ...patch,
});

test('an idle snapshot keeps the reply and tool rows already on screen', () => {
  const shown = mergeLiveFrame(
    { call: '5', thinking: '先看', text: '基尔霍夫', steps: [{ name: 'campus_exams', status: 'running' }] },
    frame({ version: 0, call: '0', steps: [] }),
  );
  assert.equal(shown.text, '基尔霍夫');
  assert.equal(shown.thinking, '先看');
  assert.equal(shown.steps.length, 1);
  assert.equal(mergeLiveFrame(shown, frame({ version: null, text: '' })).text, '基尔霍夫');
  const updated = mergeLiveFrame(shown, frame({ version: null, steps: [{ name: 'campus_exams', status: 'failed' }] }));
  assert.equal(updated.steps[0].status, 'failed');
  assert.equal(updated.text, '基尔霍夫');
});

test('a new model call does not blank the reply until it has written text', () => {
  const shown = { call: '5', thinking: '想过', text: '上一轮', steps: [{ name: 'bash', input: 'ls', status: 'done' }] };
  const held = mergeLiveFrame(shown, frame({ version: 4, call: '6', thinking: '', text: '' }));
  assert.equal(held.text, '上一轮');
  assert.equal(held.call, '5');
  const next = mergeLiveFrame(held, frame({ version: 5, call: '6', text: '新的回答', thinking: '再想' }));
  assert.equal(next.text, '新的回答');
  assert.equal(next.call, '6');
  assert.equal(next.thinking, '再想');
});

test('deltas append, and a non-empty tool list replaces the previous rows', () => {
  const first = mergeLiveFrame(undefined, frame({ thinking: '先', text: '答', steps: [{ name: 'list_tree', status: 'running' }] }));
  const more = mergeLiveFrame(first, frame({
    version: 2, thinkingFrom: 3, thinking: '分析', textFrom: 3, text: '案',
    steps: [{ name: 'list_tree', status: 'done' }, { name: 'read_entry', input: '{"title":"电路"}', status: 'running' }],
  }));
  assert.equal(more.thinking, '先分析');
  assert.equal(more.text, '答案');
  assert.equal(more.steps[1].name, 'read_entry');
  assert.equal(mergeLiveFrame(more, frame({ version: 3, steps: [] })).steps.length, 2);
});

test('token speed counts CJK as one token and waits until a rate is meaningful', () => {
  assert.equal(estimateTokens('abcd'), 1);
  assert.equal(estimateTokens('基尔霍夫'), 4);
  assert.equal(estimateTokens('ab基'), 2);
  assert.equal(formatTokenRate(4, 200), '');
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

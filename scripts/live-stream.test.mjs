import assert from 'node:assert/strict';
import test from 'node:test';
import { estimateTokens, formatTokenRate, inputPreview, mergeLiveFrame } from '../src/lib/live-stream.ts';
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
  assert.deepEqual(matchingCommands('/co').map(command => command.name), ['/copy', '/compact']);
  assert.equal(matchingCommands('/compact')[0].available, false);
});

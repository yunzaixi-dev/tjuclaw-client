import assert from 'node:assert/strict';
import test from 'node:test';
import { findDisplayMath } from '../src/components/display-math.ts';

test('display delimiters own blank lines and leave adjacent prose intact', () => {
  const source = 'before\n$$\n\\begin{aligned}\n  x &= 1 \\\\\n\n  y &= 2\n\\end{aligned}\n$$\nafter';
  const [block] = findDisplayMath(source);
  assert.equal(block.from, source.indexOf('$$'));
  assert.equal(block.to, source.lastIndexOf('$$') + 2);
  assert.equal(block.tex, '\\begin{aligned}\n  x &= 1 \\\\\n\n  y &= 2\n\\end{aligned}');
  assert.equal(source.slice(block.contentFrom, block.contentFrom + 6), '\\begin');
});

test('quoted blocks strip Markdown markers but keep LaTeX indentation', () => {
  const [block] = findDisplayMath('> $$\n> \\begin{cases}\n>   x & y\n> \\end{cases}\n> $$');
  assert.equal(block.tex, '\\begin{cases}\n  x & y\n\\end{cases}');
});

test('multiple standalone and same-line formulas have separate source ranges', () => {
  const source = '$$x=1$$\ntext\n$$\ny=2\n$$';
  assert.deepEqual(findDisplayMath(source).map(block => block.tex), ['x=1', 'y=2']);
});

test('incomplete, inline and escaped delimiters stay as source', () => {
  assert.deepEqual(findDisplayMath('$$\nx=1'), []);
  assert.deepEqual(findDisplayMath('cost $$x$$ or \\$x\\$'), []);
  assert.deepEqual(findDisplayMath('\\$$x$$'), []);
  assert.deepEqual(findDisplayMath('$$x\\$$'), []);
});

test('syntax-tree exclusions keep formulas in code examples literal', () => {
  const source = '```tex\n$$\nx=1\n$$\n```\n\n$$y=2$$';
  const blocks = findDisplayMath(source, position => position < source.lastIndexOf('```') + 3);
  assert.deepEqual(blocks.map(block => block.tex), ['y=2']);
});

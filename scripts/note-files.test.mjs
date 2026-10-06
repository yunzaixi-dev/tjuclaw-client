import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

const source = ts.transpileModule(await readFile(new URL('../src/lib/note-files.ts', import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const notes = await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const entry = (id, title, kind = 'note', parent_id = '') => ({ id, title, kind, parent_id, library_id: 'library' });
const entries = [
  entry('course', '课程', 'folder'), entry('chapter', '章节', 'folder', 'course'),
  entry('assets', 'assets', 'folder', 'course'), entry('other', '其他', 'folder'),
  entry('source', '首页', 'note', 'chapter'),
  entry('target', '复习', 'note', 'course'), entry('duplicate', '复习', 'note', 'other'),
  entry('pic', '图 #1.png', 'file', 'assets'), entry('wrong', '图 #1.png', 'file', 'other'),
  entry('localpic', 'local.png', 'file', 'chapter'), entry('rootpic', 'local.png', 'file'),
];

test('relative attachments resolve against the source directory, not an arbitrary basename', () => {
  notes.setNoteFiles(entries);
  assert.equal(notes.resolveNoteFile('../assets/%E5%9B%BE%20%231.png', 'source'), '/api/entries/pic/file');
  assert.equal(notes.resolveNoteFile('./local.png', 'source'), '/api/entries/localpic/file');
  assert.equal(notes.resolveNoteFile('../missing/图 #1.png', 'source'), null);
});

test('note links resolve paths, extensions, aliases and heading fragments', () => {
  notes.setNoteFiles(entries);
  assert.deepEqual(notes.resolveNoteLink('../复习.md#重点', 'source'), { id: 'target', fragment: '重点' });
  assert.deepEqual(notes.resolveNoteLink('课程/复习|别名', 'source'), { id: 'target', fragment: '' });
  assert.deepEqual(notes.resolveNoteLink('#本页', 'source'), { id: 'source', fragment: '本页' });
  assert.equal(notes.resolveNoteLink('复习'), null);
});

test('never resolve unsafe or outside-library targets and clear the old library index', () => {
  notes.setNoteFiles(entries);
  for (const target of ['https://example.com/复习.md', '//example.com/复习.md', '../../../复习.md', 'javascript:alert(1)']) {
    assert.equal(notes.resolveNoteLink(target, 'source'), null);
  }
  notes.setNoteFiles([]);
  assert.equal(notes.resolveNoteFile('local.png', 'source'), null);
});

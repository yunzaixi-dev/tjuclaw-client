import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

globalThis.crypto ??= webcrypto;
const compile = async name => ts.transpileModule(await readFile(new URL(name, import.meta.url), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const sealed = await import(`data:text/javascript;base64,${Buffer.from(await compile('../src/lib/sealed-vault.ts')).toString('base64')}`);
globalThis.__sealedVault = sealed;
const notesSource = (await compile('../src/lib/private-notes.ts'))
  .replace(/import \{ deleteVaultObject, readVaultObject, VaultError, writeVaultObject \} from '\.\/sealed-vault';/,
    'const { deleteVaultObject, readVaultObject, VaultError, writeVaultObject } = globalThis.__sealedVault;');
const notes = await import(`data:text/javascript;base64,${Buffer.from(notesSource).toString('base64')}`);
globalThis.__privateNotes = notes;
globalThis.__legacyEntry = null;
globalThis.__library = { getEntry: async () => globalThis.__legacyEntry };
const importSource = (await compile('../src/lib/private-note-import.ts'))
  .replace(/import \{ getEntry \} from '\.\/library';/,
    'const { getEntry } = globalThis.__library;')
  .replace(/import \{ createPrivateNote, listPrivateNotes, readPrivateNote \} from '\.\/private-notes';/,
    'const { createPrivateNote, listPrivateNotes, readPrivateNote } = globalThis.__privateNotes;')
  .replace(/import \{ VaultError \} from '\.\/sealed-vault';/,
    'const { VaultError } = globalThis.__sealedVault;');
const legacyImport = await import(`data:text/javascript;base64,${Buffer.from(importSource).toString('base64')}`);
const workspace = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const otherWorkspace = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const media = 'application/vnd.tjuclaw.sealed+json';
const originalFetch = globalThis.fetch;

function mockStore() {
  const objects = new Map();
  const writes = [];
  let sequence = 0;
  globalThis.fetch = async (path, init) => {
    const id = path.split('/').at(-1);
    assert.match(path, /^\/api\/vault\/objects\/[0-9a-f]{32}$/);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    const current = objects.get(id);
    if (init.method === 'GET') {
      return current ? new Response(JSON.stringify(current.object), {
        status: 200, headers: { 'Content-Type': media, ETag: current.revision },
      }) : new Response('', { status: 404 });
    }
    if (init.method === 'DELETE') {
      if (!current) return new Response('', { status: 404 });
      if (init.headers['If-Match'] !== current.revision) return new Response('', { status: 409 });
      objects.delete(id);
      return new Response(null, { status: 204 });
    }
    assert.equal(init.method, 'PUT');
    writes.push(init.body);
    if (current ? init.headers['If-Match'] !== current.revision : init.headers['If-None-Match'] !== '*') {
      return new Response('', { status: 409 });
    }
    const revision = `"${(++sequence).toString(16).padStart(40, '0')}"`;
    objects.set(id, { revision, object: JSON.parse(init.body) });
    return new Response('{"ok":true}', { status: current ? 200 : 201, headers: { ETag: revision } });
  };
  return { objects, writes };
}

test('private notebook uses only sealed Forgejo objects, and CAS preserves concurrent edits', async () => {
  const { objects, writes } = mockStore();
  try {
    const passphrase = 'per workspace passphrase';
    const empty = await notes.listPrivateNotes(workspace, passphrase);
    assert.deepEqual(empty, { notes: [], pendingDeletes: [] });
    const first = await notes.createPrivateNote(workspace, passphrase, 'Sensitive title', 'Private body', empty);
    assert.equal(first.notebook.notes.length, 1);
    assert.equal(objects.size, 2);
    assert.notEqual(first.id, await notes.privateNotebookID(workspace));
    assert.equal((await notes.readPrivateNote(workspace, first.id, passphrase)).body, 'Private body');
    assert.deepEqual(await notes.listPrivateNotes(workspace, passphrase), first.notebook);
    const second = await notes.createPrivateNote(workspace, passphrase, 'Another secret title', '', first.notebook);
    assert.equal(second.notebook.notes.length, 2);
    assert.equal(objects.size, 3);
    assert.equal(writes.some(payload => /Sensitive title|Private body|Another secret title|per workspace passphrase/.test(payload)), false);

    const newRevision = await notes.updatePrivateNote(workspace, first.id, passphrase, 'Latest private body', first.contentRevision);
    assert.equal((await notes.readPrivateNote(workspace, first.id, passphrase)).body, 'Latest private body');
    await assert.rejects(notes.updatePrivateNote(workspace, first.id, passphrase, 'stale device write', first.contentRevision),
      error => error.status === 409);
    assert.equal((await notes.readPrivateNote(workspace, first.id, passphrase)).revision, newRevision);
    assert.equal((await notes.readPrivateNote(workspace, first.id, passphrase)).body, 'Latest private body');
    const merged = await notes.createPrivateNote(workspace, passphrase, 'Stale index', 'Concurrent body', first.notebook);
    assert.deepEqual(merged.notebook.notes.map(note => note.title),
      ['Sensitive title', 'Another secret title', 'Stale index']);
    assert.equal((await notes.readPrivateNote(workspace, merged.id, passphrase)).body, 'Concurrent body');
    assert.deepEqual(await notes.listPrivateNotes(workspace, passphrase), merged.notebook);
    assert.equal(writes.some(payload => /Concurrent body|Stale index/.test(payload)), false);
    await assert.rejects(notes.readPrivateNote(otherWorkspace, first.id, passphrase),
      /private_note_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private notebook never retries an uncertain index write, but reconciles a committed response loss', async () => {
  const { objects } = mockStore();
  try {
    const passphrase = 'per workspace passphrase';
    const index = await notes.privateNotebookID(workspace);
    const underlying = globalThis.fetch;
    let indexWrites = 0;
    globalThis.fetch = async (path, init) => {
      if (path.endsWith(index) && init.method === 'PUT') {
        indexWrites++;
        return new Response('', { status: 503 });
      }
      return underlying(path, init);
    };
    await assert.rejects(notes.createPrivateNote(workspace, passphrase, 'Failed index', '', { notes: [], pendingDeletes: [] }),
      error => error.status === 503);
    assert.equal(indexWrites, 1);
    assert.equal(objects.has(index), false);

    globalThis.fetch = async (path, init) => {
      const result = await underlying(path, init);
      if (path.endsWith(index) && init.method === 'PUT') {
        indexWrites++;
        return new Response('', { status: 503 });
      }
      return result;
    };
    const recovered = await notes.createPrivateNote(workspace, passphrase, 'Committed index', '', { notes: [], pendingDeletes: [] });
    assert.equal(indexWrites, 2);
    assert.deepEqual((await notes.listPrivateNotes(workspace, passphrase)).notes, recovered.notebook.notes);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private note bounds and corrupted index fail closed without publishing titles', async () => {
  const { objects, writes } = mockStore();
  try {
    const password = 'key';
    const index = await notes.privateNotebookID(workspace);
    await assert.rejects(notes.createPrivateNote(workspace, password, 'x', 'a'.repeat(80 * 1024 + 1), { notes: [], pendingDeletes: [] }),
      error => error.status === 413);
    assert.equal(writes.length, 0);
    const bad = await sealed.sealObject(index, password,
      JSON.stringify({ version: 1, workspace_id: workspace, notes: [
        { id: '1'.repeat(32), title: 'title' }, { id: '1'.repeat(32), title: 'duplicate' },
      ] }));
    objects.set(index, { object: bad, revision: `"${'2'.repeat(40)}"` });
    await assert.rejects(notes.listPrivateNotes(workspace, password), /private_notebook_invalid/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private note deletion journals encrypted cleanup and resumes after a failed delete', async () => {
  const { objects, writes } = mockStore();
  try {
    const passphrase = 'per workspace passphrase';
    const index = await notes.privateNotebookID(workspace);
    const first = await notes.createPrivateNote(workspace, passphrase, 'private title', 'private body',
      { notes: [], pendingDeletes: [] });
    const firstRevision = first.contentRevision;
    const underlying = globalThis.fetch;
    let deletes = 0;
    globalThis.fetch = async (path, init) => {
      if (path.endsWith(first.id) && init.method === 'DELETE') {
        deletes++;
        return new Response('', { status: 503 });
      }
      return underlying(path, init);
    };
    const pending = await notes.deletePrivateNote(workspace, first.id, passphrase, first.notebook, firstRevision);
    assert.equal(deletes, 1);
    assert.deepEqual(pending.notes, []);
    assert.deepEqual(pending.pendingDeletes, [{ id: first.id, revision: firstRevision }]);
    assert.equal(objects.has(first.id), true);
    assert.equal(objects.has(index), true);
    assert.deepEqual(await notes.listPrivateNotes(workspace, passphrase), pending);
    const renamed = await notes.createPrivateNote(workspace, passphrase, 'new note', '', pending);
    assert.deepEqual(renamed.notebook.pendingDeletes, pending.pendingDeletes);
    assert.equal(writes.some(payload => /private title|private body|new note/.test(payload)), false);
    globalThis.fetch = underlying;
    const cleaned = await notes.retryPrivateNoteCleanup(workspace, passphrase,
      await notes.listPrivateNotes(workspace, passphrase));
    assert.deepEqual(cleaned.pendingDeletes, []);
    assert.equal(cleaned.notes.length, 1);
    assert.equal(cleaned.notes[0].id, renamed.id);
    assert.equal(objects.has(first.id), false);
    assert.deepEqual(await notes.listPrivateNotes(workspace, passphrase), cleaned);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('stale notebook cannot delete an object after another device renames it', async () => {
  const { objects } = mockStore();
  try {
    const passphrase = 'per workspace passphrase';
    const first = await notes.createPrivateNote(workspace, passphrase, 'original', 'private body',
      { notes: [], pendingDeletes: [] });
    const latest = await notes.renamePrivateNote(workspace, first.id, passphrase, 'another device', first.notebook);
    await assert.rejects(notes.deletePrivateNote(workspace, first.id, passphrase,
      first.notebook, first.contentRevision), error => error.status === 409);
    assert.equal(objects.has(first.id), true);
    assert.deepEqual(await notes.listPrivateNotes(workspace, passphrase), latest);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('private deletion resumes when clearing a tombstone fails after object removal', async () => {
  const { objects } = mockStore();
  try {
    const passphrase = 'per workspace passphrase';
    const first = await notes.createPrivateNote(workspace, passphrase, 'private title', 'private body',
      { notes: [], pendingDeletes: [] });
    const index = await notes.privateNotebookID(workspace);
    const underlying = globalThis.fetch;
    let indexWrites = 0;
    globalThis.fetch = async (path, init) => {
      if (path.endsWith(index) && init.method === 'PUT' && ++indexWrites === 2) {
        return new Response('', { status: 503 });
      }
      return underlying(path, init);
    };
    const pending = await notes.deletePrivateNote(workspace, first.id, passphrase,
      first.notebook, first.contentRevision);
    assert.equal(objects.has(first.id), false);
    assert.equal(pending.pendingDeletes.length, 1);
    assert.equal((await notes.listPrivateNotes(workspace, passphrase)).pendingDeletes.length, 1);
    globalThis.fetch = underlying;
    const cleaned = await notes.retryPrivateNoteCleanup(workspace, passphrase,
      await notes.listPrivateNotes(workspace, passphrase));
    assert.deepEqual(cleaned.pendingDeletes, []);
    assert.deepEqual(cleaned.notes, []);
    assert.equal(indexWrites, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('legacy Markdown copy encrypts source and title, verifies readback, leaves source untouched and rejects duplicates', async () => {
  const { objects, writes } = mockStore();
  const entryId = '11111111111111111111111111111111';
  const source = { id: entryId, library_id: workspace, kind: 'note',
    title: 'Legacy secret', body: '# Legacy plaintext' };
  globalThis.__legacyEntry = source;
  try {
    const empty = await notes.listPrivateNotes(workspace, 'passphrase');
    const imported = await legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase', empty);
    assert.equal(imported.body, source.body);
    assert.equal(imported.notebook.notes[0].legacy_entry_id, entryId);
    assert.equal((await notes.readPrivateNote(workspace, imported.id, 'passphrase')).body, source.body);
    assert.deepEqual(globalThis.__legacyEntry, source);
    assert.equal(objects.size, 2);
    assert.equal(writes.some(payload => /Legacy secret|Legacy plaintext|passphrase|legacy_entry_id/.test(payload)), false);
    await assert.rejects(legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase', imported.notebook),
      error => error.status === 409 && error.message === 'private_import_exists');
    assert.equal(objects.size, 2);
    globalThis.__legacyEntry = { ...source, library_id: otherWorkspace };
    await assert.rejects(legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase', empty),
      error => error.status === 400);
    assert.equal(objects.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__legacyEntry = null;
  }
});

test('copy of an empty legacy note handles omitted body and never converts rich text', async () => {
  const { objects } = mockStore();
  const entryId = '22222222222222222222222222222222';
  try {
    globalThis.__legacyEntry = { id: entryId, library_id: workspace, kind: 'rich_text', title: 'Do not convert' };
    await assert.rejects(legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase',
      { notes: [], pendingDeletes: [] }), error => error.status === 400);
    assert.equal(objects.size, 0);
    globalThis.__legacyEntry = { ...globalThis.__legacyEntry, kind: 'note' };
    const imported = await legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase',
      { notes: [], pendingDeletes: [] });
    assert.equal(imported.body, '');
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__legacyEntry = null;
  }
});

test('unverified legacy copy remains indexed and warns instead of claiming success', async () => {
  const { objects } = mockStore();
  const entryId = '33333333333333333333333333333333';
  globalThis.__legacyEntry = { id: entryId, library_id: workspace, kind: 'note',
    title: 'Do not lose this', body: 'private source' };
  const underlying = globalThis.fetch;
  const indexID = await notes.privateNotebookID(workspace);
  let blockReadback = false;
  try {
    globalThis.fetch = async (path, init) => {
      if (path.endsWith(indexID) && init.method === 'PUT') blockReadback = true;
      if (blockReadback && init.method === 'GET') return new Response('', { status: 503 });
      return underlying(path, init);
    };
    await assert.rejects(legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase',
      { notes: [], pendingDeletes: [] }), error => error.status === 502 && error.message === 'private_import_unverified');
    assert.equal(objects.size, 2);
    globalThis.fetch = underlying;
    const recovered = await notes.listPrivateNotes(workspace, 'passphrase');
    assert.equal(recovered.notes[0].legacy_entry_id, entryId);
    assert.equal((await notes.readPrivateNote(workspace, recovered.notes[0].id, 'passphrase')).body, 'private source');
    await assert.rejects(legacyImport.copyLegacyMarkdownNote(workspace, entryId, 'passphrase', recovered),
      error => error.status === 409);
    assert.equal(objects.size, 2);
  } finally {
    globalThis.fetch = originalFetch;
    globalThis.__legacyEntry = null;
  }
});

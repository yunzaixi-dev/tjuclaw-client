import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { webcrypto } from 'node:crypto';
import ts from 'typescript';

const source = await readFile(new URL('../src/lib/sealed-vault.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
globalThis.crypto ??= webcrypto;
const { sealObject, openObject, readVaultObject, writeVaultObject, deleteVaultObject } =
  await import(`data:text/javascript;base64,${Buffer.from(output).toString('base64')}`);
const id = '0123456789abcdef0123456789abcdef';
const otherID = 'fedcba9876543210fedcba9876543210';
const sha = '"0123456789abcdef0123456789abcdef01234567"';
const type = 'application/vnd.tjuclaw.sealed+json';

test('sealed objects round trip without exposing plaintext, and reject replay or tampering', async () => {
  const first = await sealObject(id, 'secret passphrase', '秘密笔记\nsecond line');
  const second = await sealObject(id, 'secret passphrase', '秘密笔记\nsecond line');
  assert.notEqual(first.salt, second.salt);
  assert.notEqual(first.nonce, second.nonce);
  assert.doesNotMatch(JSON.stringify(first), /秘密笔记|secret passphrase/);
  assert.equal(await openObject(id, 'secret passphrase', first), '秘密笔记\nsecond line');
  await assert.rejects(openObject(id, 'wrong passphrase', first), /vault_decryption_failed/);
  await assert.rejects(openObject(otherID, 'secret passphrase', first), /vault_decryption_failed/);
  const altered = { ...first, ciphertext: first.ciphertext.slice(0, -2) + 'AA' };
  await assert.rejects(openObject(id, 'secret passphrase', altered), /vault_decryption_failed|vault_invalid_object/);
  await assert.rejects(openObject(id, 'secret passphrase', { ...first, extra: 'x' }), /vault_invalid_object/);
  await assert.rejects(sealObject('../bad-path', 'secret passphrase', 'x'), /vault_invalid_id/);
  await assert.rejects(sealObject(id, 'secret passphrase', 'x'.repeat(96 << 10)), /vault_object_too_large/);
});

test('same-origin transport sends only sealed bytes and enforces revision conditions', async () => {
  const originalFetch = globalThis.fetch;
  const observed = [];
  let saved;
  globalThis.fetch = async (path, init) => {
    observed.push({ path, init });
    assert.equal(path, `/api/vault/objects/${id}`);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.redirect, 'error');
    assert.equal(init.cache, 'no-store');
    if (init.method === 'PUT') {
      saved = JSON.parse(init.body);
      assert.doesNotMatch(init.body, /secret passphrase|private plaintext/);
      assert.equal(init.headers['Content-Type'], type);
      return new Response('{"ok":true}', { status: observed.length === 1 ? 201 : 200, headers: { ETag: sha } });
    }
    return new Response(JSON.stringify(saved), { status: 200, headers: { 'Content-Type': type, ETag: sha } });
  };
  try {
    assert.equal(await writeVaultObject(id, 'secret passphrase', 'private plaintext'), sha);
    assert.equal(observed[0].init.headers['If-None-Match'], '*');
    assert.equal((await readVaultObject(id, 'secret passphrase')).plaintext, 'private plaintext');
    assert.equal(await writeVaultObject(id, 'secret passphrase', 'updated', sha), sha);
    assert.equal(observed[2].init.headers['If-Match'], sha);
    assert.equal(observed[2].init.headers['If-None-Match'], undefined);
    await assert.rejects(writeVaultObject(id, 'secret passphrase', 'x', '"bad"'), /vault_invalid_revision/);
    assert.equal(observed.length, 3);
    globalThis.fetch = async () => new Response('{"error":{"id":"vault_revision_conflict"}}', { status: 409 });
    await assert.rejects(writeVaultObject(id, 'secret passphrase', 'x', sha), error => error.status === 409);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('lost sealed write response is reconciled without retrying or overwriting another edit', async () => {
  const originalFetch = globalThis.fetch;
  const original = await sealObject(id, 'secret passphrase', 'original');
  const competing = await sealObject(id, 'secret passphrase', 'other device');
  let stored = original;
  let writeCount = 0;
  let readCount = 0;
  globalThis.fetch = async (_path, init) => {
    if (init.method === 'PUT') {
      writeCount++;
      assert.equal(init.headers['If-Match'], sha);
      stored = JSON.parse(init.body);
      throw new TypeError('response lost after server commit');
    }
    readCount++;
    return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': type, ETag: sha } });
  };
  try {
    assert.equal(await writeVaultObject(id, 'secret passphrase', 'new content', sha), sha);
    assert.equal(writeCount, 1);
    assert.equal(readCount, 1);

    globalThis.fetch = async (_path, init) => {
      if (init.method === 'PUT') {
        writeCount++;
        return new Response('{"error":{"id":"vault_revision_conflict"}}', { status: 409 });
      }
      readCount++;
      return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': type, ETag: sha } });
    };
    assert.equal(await writeVaultObject(id, 'secret passphrase', 'new content', sha), sha);
    assert.equal(writeCount, 2);
    assert.equal(readCount, 2);

    globalThis.fetch = async (_path, init) => {
      if (init.method === 'PUT') {
        writeCount++;
        stored = competing;
        return new Response('{"error":{"id":"vault_revision_conflict"}}', { status: 409 });
      }
      readCount++;
      return new Response(JSON.stringify(stored), { status: 200, headers: { 'Content-Type': type, ETag: sha } });
    };
    await assert.rejects(writeVaultObject(id, 'secret passphrase', 'my conflicting edit', sha),
      error => error.status === 409);
    assert.equal(await openObject(id, 'secret passphrase', stored), 'other device');
    assert.equal(writeCount, 3);
    assert.equal(readCount, 3);

    globalThis.fetch = async (_path, init) => {
      assert.equal(init.method, 'PUT', 'authorization failure must not read back the private object');
      return new Response('{"error":{"id":"unauthorized"}}', { status: 401 });
    };
    await assert.rejects(writeVaultObject(id, 'secret passphrase', 'unauthorized edit', sha),
      error => error.status === 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('delete uses conditional same-origin request and reconciles only a confirmed absence', async () => {
  const originalFetch = globalThis.fetch;
  let deletes = 0;
  let reads = 0;
  let present = true;
  globalThis.fetch = async (path, init) => {
    assert.equal(path, `/api/vault/objects/${id}`);
    assert.equal(init.credentials, 'same-origin');
    assert.equal(init.cache, 'no-store');
    if (init.method === 'DELETE') {
      deletes++;
      assert.equal(init.headers['If-Match'], sha);
      assert.equal(init.body, undefined);
      present = false;
      throw new TypeError('response lost');
    }
    reads++;
    return new Response('', { status: present ? 200 : 404 });
  };
  try {
    await assert.rejects(deleteVaultObject(id, 'bad'), /vault_invalid_revision/);
    assert.equal(deletes, 0);
    await deleteVaultObject(id, sha);
    assert.equal(deletes, 1);
    assert.equal(reads, 1);
    globalThis.fetch = async (_path, init) => {
      if (init.method === 'DELETE') {
        deletes++;
        return new Response('{"error":{"id":"vault_revision_conflict"}}', { status: 409 });
      }
      reads++;
      return new Response('{}', { status: 200 });
    };
    await assert.rejects(deleteVaultObject(id, sha), error => error.status === 409);
    assert.equal(deletes, 2);
    assert.equal(reads, 2);
    globalThis.fetch = async (_path, init) => {
      assert.equal(init.method, 'DELETE', 'authorization failure must not trigger readback');
      return new Response('', { status: 401 });
    };
    await assert.rejects(deleteVaultObject(id, sha), error => error.status === 401);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

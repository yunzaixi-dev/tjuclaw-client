import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import ts from 'typescript';

globalThis.crypto ??= webcrypto;
const compile = async path => {
  const source = await readFile(new URL(path, import.meta.url), 'utf8');
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  }).outputText;
};
const sealed = await import(`data:text/javascript;base64,${Buffer.from(await compile('../src/lib/sealed-vault.ts')).toString('base64')}`);
globalThis.__sealedVault = sealed;
globalThis.__AuthError = class AuthError extends Error {
  constructor(status) {
    super(`status ${status}`);
    this.status = status;
  }
};
globalThis.__authRequest = async path => {
  const response = await fetch(path, { credentials: 'same-origin' });
  if (!response.ok) throw new globalThis.__AuthError(response.status);
  return response.json();
};
const vaultSource = (await compile('../src/lib/workspace-vault.ts'))
  .replace(/import \{ readVaultObject, VaultError, writeVaultObject \} from '\.\/sealed-vault';/,
    'const { readVaultObject, VaultError, writeVaultObject } = globalThis.__sealedVault;')
  .replace(/import \{ authRequest(, AuthError)? \} from '\.\/auth';/,
    'const authRequest = globalThis.__authRequest; const AuthError = globalThis.__AuthError;');
const vault = await import(`data:text/javascript;base64,${Buffer.from(vaultSource).toString('base64')}`);
const library = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const secondLibrary = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const sha = '"0123456789abcdef0123456789abcdef01234567"';
const media = 'application/vnd.tjuclaw.sealed+json';
const savedFetch = globalThis.fetch;
const storage = new Map();
globalThis.localStorage = {
  getItem: key => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
};
globalThis.sessionStorage = {
  getItem: key => storage.get(`session:${key}`) ?? null,
  setItem: (key, value) => storage.set(`session:${key}`, value),
  removeItem: key => storage.delete(`session:${key}`),
};

test('remote verifier can be unlocked after local state is cleared without storing the passphrase', async () => {
  const objects = new Map();
  let writes = 0;
  let currentSha = sha;
  globalThis.fetch = async (path, init = {}) => {
    if (path === '/api/vault/status') return Response.json({ configured: true });
    assert.match(path, /^\/api\/vault\/objects\/[0-9a-f]{32}$/);
    assert.equal(init.credentials, 'same-origin');
    const id = path.split('/').at(-1);
    if (init.method === 'GET') {
      return objects.has(id)
        ? new Response(JSON.stringify(objects.get(id)), { headers: { 'Content-Type': media, ETag: currentSha } })
        : new Response('', { status: 404 });
    }
    writes++;
    assert.equal(init.headers['If-None-Match'], '*');
    assert.doesNotMatch(init.body, /secret passphrase|workspace-verifier/);
    objects.set(id, JSON.parse(init.body));
    return new Response('{"ok":true}', { status: 201, headers: { ETag: sha } });
  };
  try {
    assert.equal(await vault.workspaceVerification(), 'remote');
    assert.equal((await vault.workspacePassphraseState('user-a', library, 'remote')).mode, 'setup');
    await vault.createRemoteWorkspacePassphrase('user-a', library, 'secret passphrase');
    assert.equal(writes, 1);
    assert.equal(vault.hasWorkspacePassphrase('user-a', library), false);
    vault.clearWorkspaceUnlock('user-a', library);
    assert.deepEqual(await vault.workspacePassphraseState('user-a', library, 'remote'),
      { verification: 'remote', mode: 'unlock', unlocked: false });
    await assert.rejects(vault.unlockRemoteWorkspace('user-a', library, 'wrong passphrase'), /vault_decryption_failed/);
    await vault.unlockRemoteWorkspace('user-a', library, 'secret passphrase');
    assert.equal(vault.isWorkspaceUnlocked('user-a', library, 'remote'), true);
    currentSha = '"fedcba9876543210fedcba9876543210fedcba98"';
    assert.equal((await vault.workspacePassphraseState('user-a', library, 'remote')).unlocked, false);
    vault.clearRemoteWorkspaceUnlocks();
    assert.equal(vault.isWorkspaceUnlocked('user-a', library, 'remote'), false);
  } finally {
    globalThis.fetch = savedFetch;
  }
});

test('existing local verifier migrates once, and conflicting remote setup is never overwritten', async () => {
  const objects = new Map();
  let writes = 0;
  globalThis.fetch = async (path, init = {}) => {
    if (path === '/api/vault/status') return Response.json({ configured: true });
    const id = path.split('/').at(-1);
    if (init.method === 'GET') {
      return objects.has(id)
        ? new Response(JSON.stringify(objects.get(id)), { headers: { 'Content-Type': media, ETag: sha } })
        : new Response('', { status: 404 });
    }
    writes++;
    if (objects.has(id)) return new Response('', { status: 409 });
    objects.set(id, JSON.parse(init.body));
    return new Response('{"ok":true}', { status: 201, headers: { ETag: sha } });
  };
  try {
    await vault.createWorkspacePassphrase('user-a', library, 'original password');
    assert.equal((await vault.workspacePassphraseState('user-a', library, 'remote')).mode, 'migrate');
    await assert.rejects(vault.migrateWorkspacePassphrase('user-a', library, 'wrong password'), /workspace_passphrase_invalid/);
    assert.equal(writes, 0);
    await vault.migrateWorkspacePassphrase('user-a', library, 'original password');
    assert.equal(writes, 1);
    assert.equal(vault.hasWorkspacePassphrase('user-a', library), true);
    assert.equal((await vault.workspacePassphraseState('user-a', library, 'remote')).mode, 'unlock');

    await vault.createWorkspacePassphrase('user-a', secondLibrary, 'old password');
    const secondId = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',
      new TextEncoder().encode(`tjuclaw:workspace-verifier:v1:${secondLibrary}`)))).slice(0, 16)
      .map(byte => byte.toString(16).padStart(2, '0')).join('');
    objects.set(secondId, await sealed.sealObject(secondId, 'another device password',
      `tjuclaw:workspace-verifier:v1:${secondLibrary}`));
    await assert.rejects(vault.migrateWorkspacePassphrase('user-a', secondLibrary, 'old password'),
      error => error.status === 409);
    assert.equal(vault.isWorkspaceUnlocked('user-a', secondLibrary, 'remote'), false);
    assert.equal(writes, 2);
  } finally {
    vault.clearRemoteWorkspaceUnlocks();
    globalThis.fetch = savedFetch;
  }
});

test('configured gateway failures and malformed capability status never downgrade to local', async () => {
  globalThis.fetch = async path => {
    if (path === '/api/vault/status') return Response.json({ configured: true });
    return new Response('', { status: 503 });
  };
  try {
    vault.markWorkspaceUnlocked('user-a', library);
    await assert.rejects(vault.workspacePassphraseState('user-a', library, 'remote'),
      error => error.status === 503);
    globalThis.fetch = async () => Response.json({ configured: 'yes' });
    await assert.rejects(vault.workspaceVerification(), /workspace_vault_unavailable/);
    globalThis.fetch = async () => Response.json({ configured: false });
    assert.equal(await vault.workspaceVerification(), 'local');
    assert.equal((await vault.workspacePassphraseState('user-a', library, 'local')).unlocked, true);
  } finally {
    vault.clearWorkspaceUnlock('user-a', library);
    globalThis.fetch = savedFetch;
  }
});

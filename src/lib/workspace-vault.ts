import { readVaultObject, VaultError, writeVaultObject } from './sealed-vault';
import { authRequest, AuthError } from './auth';

const encoder = new TextEncoder();
const STORAGE_PREFIX = 'tjuclaw.workspace.vault.v1';
const SESSION_PREFIX = 'tjuclaw.workspace.unlock.v1';
const ITERATIONS = 210_000;
export const MIN_WORKSPACE_PASSPHRASE_LENGTH = 6;
export const MAX_WORKSPACE_PASSPHRASE_LENGTH = 64;

type WorkspaceVaultRecord = {
  version: 1;
  salt: string;
  verifier: string;
  created_at: string;
};

export type WorkspaceVerification = 'local' | 'remote';
export type WorkspacePassphraseState = {
  verification: WorkspaceVerification;
  mode: 'setup' | 'unlock' | 'migrate';
  unlocked: boolean;
};
const remoteUnlocks = new Map<string, string>();

// "Keep this device unlocked": after a correct passphrase the device may skip
// the gate for a while. What is kept is not the passphrase and not a key, only
// which verifier was unlocked and until when, so a passphrase changed on
// another device asks again here. Private notes are encrypted with the
// passphrase itself and still ask for it when they are opened.
const REMEMBER_PREFIX = 'tjuclaw.workspace.remembered.v1';
export const REMEMBER_DAYS = 30;

function rememberKey(identity: string, workspaceId: string) {
  return `${REMEMBER_PREFIX}.${identity}.${workspaceId}`;
}

/** What the unlock is tied to: the remote verifier's revision, or the local record's creation time. */
function unlockBinding(identity: string, workspaceId: string, verification: WorkspaceVerification) {
  return verification === 'remote' ? remoteUnlocks.get(remoteKey(identity, workspaceId)) ?? '' : readRecord(identity, workspaceId)?.created_at ?? '';
}

function remembered(identity: string, workspaceId: string, binding: string) {
  if (!binding) return false;
  try {
    const value = JSON.parse(localStorage.getItem(rememberKey(identity, workspaceId)) ?? 'null');
    if (value?.binding === binding && typeof value.until === 'number' && value.until > Date.now()) return true;
    if (value) localStorage.removeItem(rememberKey(identity, workspaceId));
  } catch { /* Storage is unavailable or the record is damaged: ask for the passphrase. */ }
  return false;
}

/** Keeps the workspace just unlocked on this device open for the next REMEMBER_DAYS days. */
export function rememberWorkspace(identity: string, workspaceId: string, verification: WorkspaceVerification) {
  const binding = unlockBinding(identity, workspaceId, verification);
  if (!binding) return;
  try {
    localStorage.setItem(rememberKey(identity, workspaceId), JSON.stringify({ binding, until: Date.now() + REMEMBER_DAYS * 86_400_000 }));
  } catch { /* Without storage the unlock lasts for this page only. */ }
}

/** Forgets every workspace this identity kept unlocked on this device, for sign-out. */
export function forgetRememberedWorkspaces(identity: string) {
  try {
    const prefix = `${REMEMBER_PREFIX}.${identity}.`;
    for (let index = localStorage.length - 1; index >= 0; index--) {
      const key = localStorage.key(index);
      if (key?.startsWith(prefix)) localStorage.removeItem(key);
    }
  } catch { /* Nothing was kept. */ }
}

function remoteKey(identity: string, workspaceId: string) {
  return `${identity}:${workspaceId}`;
}

async function verifierObjectID(workspaceId: string) {
  if (!/^[0-9a-f]{32}$/.test(workspaceId)) throw new Error('workspace_invalid_id');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(`tjuclaw:workspace-verifier:v1:${workspaceId}`)));
  return Array.from(digest.slice(0, 16), byte => byte.toString(16).padStart(2, '0')).join('');
}

function verifierContent(workspaceId: string) {
  return `tjuclaw:workspace-verifier:v1:${workspaceId}`;
}

export async function workspaceVerification(): Promise<WorkspaceVerification> {
  // A momentary gateway hiccup should not lock the workspace; sign-in
  // problems (4xx) are reported at once, everything else is retried briefly.
  for (let attempt = 0; ; attempt++) {
    try {
      const result = await authRequest<{ configured: boolean }>('/api/vault/status');
      if (typeof result?.configured !== 'boolean') throw new Error('workspace_vault_unavailable');
      return result.configured ? 'remote' : 'local';
    } catch (error) {
      const status = error instanceof AuthError ? error.status : 0;
      if (attempt >= 2 || (status >= 400 && status < 500)) throw error;
      await new Promise(resolve => setTimeout(resolve, 600 * (attempt + 1)));
    }
  }
}

export async function workspacePassphraseState(identity: string, workspaceId: string, verification: WorkspaceVerification): Promise<WorkspacePassphraseState> {
  if (verification === 'local') {
    const configured = hasWorkspacePassphrase(identity, workspaceId);
    return { verification, mode: configured ? 'unlock' : 'setup', unlocked: configured && isWorkspaceUnlocked(identity, workspaceId) };
  }
  const id = await verifierObjectID(workspaceId);
  const response = await fetch(`/api/vault/objects/${id}`, {
    method: 'GET', credentials: 'same-origin', cache: 'no-store', redirect: 'error',
  });
  if (response.status !== 404 && !response.ok) throw new VaultError(response.status, 'vault_request_failed');
  if (response.ok && (response.headers.get('Content-Type') !== 'application/vnd.tjuclaw.sealed+json' ||
    !/^"[0-9a-f]{40}"$/.test(response.headers.get('ETag') ?? ''))) {
    throw new VaultError(502, 'vault_invalid_object');
  }
  const exists = response.ok;
  const revision = response.headers.get('ETag');
  const key = remoteKey(identity, workspaceId);
  if (exists && remoteUnlocks.has(key) && remoteUnlocks.get(key) !== revision) remoteUnlocks.delete(key);
  // The same verifier this device was told to keep unlocked.
  if (exists && revision && !remoteUnlocks.has(key) && remembered(identity, workspaceId, revision)) remoteUnlocks.set(key, revision);
  return {
    verification, mode: exists ? 'unlock' : hasWorkspacePassphrase(identity, workspaceId) ? 'migrate' : 'setup',
    unlocked: exists && remoteUnlocks.has(key),
  };
}

export async function createRemoteWorkspacePassphrase(identity: string, workspaceId: string, passphrase: string) {
  if (passphrase.length < MIN_WORKSPACE_PASSPHRASE_LENGTH) throw new Error('workspace_passphrase_too_short');
  if (passphrase.length > MAX_WORKSPACE_PASSPHRASE_LENGTH) throw new Error('workspace_passphrase_too_long');
  const revision = await writeVaultObject(await verifierObjectID(workspaceId), passphrase, verifierContent(workspaceId));
  remoteUnlocks.set(remoteKey(identity, workspaceId), revision);
}

export async function unlockRemoteWorkspace(identity: string, workspaceId: string, passphrase: string) {
  const { plaintext, revision } = await readVaultObject(await verifierObjectID(workspaceId), passphrase);
  if (plaintext !== verifierContent(workspaceId)) throw new VaultError(502, 'vault_invalid_object');
  remoteUnlocks.set(remoteKey(identity, workspaceId), revision);
}

export async function migrateWorkspacePassphrase(identity: string, workspaceId: string, passphrase: string) {
  await unlockWorkspace(identity, workspaceId, passphrase);
  await createRemoteWorkspacePassphrase(identity, workspaceId, passphrase);
}

function storageKey(identity: string, workspaceId: string) {
  return `${STORAGE_PREFIX}.${identity}.${workspaceId}`;
}

function sessionKey(identity: string, workspaceId: string) {
  return `${SESSION_PREFIX}.${identity}.${workspaceId}`;
}

function encode(bytes: Uint8Array) {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

function decode(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

async function deriveVerifier(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  if (!crypto.subtle) throw new Error('workspace_crypto_unavailable');
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
    material,
    256,
  );
  return encode(new Uint8Array(bits));
}

function readRecord(identity: string, workspaceId: string): WorkspaceVaultRecord | null {
  try {
    const value = JSON.parse(localStorage.getItem(storageKey(identity, workspaceId)) ?? '');
    if (!value || value.version !== 1 || typeof value.salt !== 'string' || typeof value.verifier !== 'string' || typeof value.created_at !== 'string') return null;
    return value as WorkspaceVaultRecord;
  } catch {
    return null;
  }
}

export function hasWorkspacePassphrase(identity: string, workspaceId: string) {
  return readRecord(identity, workspaceId) !== null;
}

export function isWorkspaceUnlocked(identity: string, workspaceId: string, verification: WorkspaceVerification = 'local') {
  if (verification === 'remote') return remoteUnlocks.has(remoteKey(identity, workspaceId));
  return sessionStorage.getItem(sessionKey(identity, workspaceId)) === 'unlocked'
    || remembered(identity, workspaceId, unlockBinding(identity, workspaceId, 'local'));
}

export function markWorkspaceUnlocked(identity: string, workspaceId: string) {
  sessionStorage.setItem(sessionKey(identity, workspaceId), 'unlocked');
}

export function clearWorkspaceUnlock(identity: string, workspaceId: string) {
  sessionStorage.removeItem(sessionKey(identity, workspaceId));
  remoteUnlocks.delete(remoteKey(identity, workspaceId));
  try { localStorage.removeItem(rememberKey(identity, workspaceId)); } catch { /* Nothing was kept. */ }
}

export function clearRemoteWorkspaceUnlocks() {
  remoteUnlocks.clear();
}

export async function createWorkspacePassphrase(identity: string, workspaceId: string, passphrase: string) {
  if (passphrase.length < MIN_WORKSPACE_PASSPHRASE_LENGTH) throw new Error('workspace_passphrase_too_short');
  if (passphrase.length > MAX_WORKSPACE_PASSPHRASE_LENGTH) throw new Error('workspace_passphrase_too_long');
  if (hasWorkspacePassphrase(identity, workspaceId)) throw new Error('workspace_passphrase_exists');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const record: WorkspaceVaultRecord = {
    version: 1,
    salt: encode(salt),
    verifier: await deriveVerifier(passphrase, salt),
    created_at: new Date().toISOString(),
  };
  localStorage.setItem(storageKey(identity, workspaceId), JSON.stringify(record));
}

export async function unlockWorkspace(identity: string, workspaceId: string, passphrase: string) {
  const record = readRecord(identity, workspaceId);
  if (!record) throw new Error('workspace_passphrase_missing');
  const verifier = await deriveVerifier(passphrase, decode(record.salt));
  if (verifier !== record.verifier) throw new Error('workspace_passphrase_invalid');
}

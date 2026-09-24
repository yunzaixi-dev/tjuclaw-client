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

export function isWorkspaceUnlocked(identity: string, workspaceId: string) {
  return sessionStorage.getItem(sessionKey(identity, workspaceId)) === 'unlocked';
}

export function markWorkspaceUnlocked(identity: string, workspaceId: string) {
  sessionStorage.setItem(sessionKey(identity, workspaceId), 'unlocked');
}

export function clearWorkspaceUnlock(identity: string, workspaceId: string) {
  sessionStorage.removeItem(sessionKey(identity, workspaceId));
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

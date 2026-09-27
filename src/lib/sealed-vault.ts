// Sealed objects use a separate key per write; no key or plaintext is persisted by this module.
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const iterations = 210_000;
const maxCiphertextBytes = 96 << 10;
const objectID = /^[0-9a-f]{32}$/;
const revisionID = /^"[0-9a-f]{40}"$/;
const contentType = 'application/vnd.tjuclaw.sealed+json';

export type SealedObject = {
  version: 1;
  salt: string;
  nonce: string;
  ciphertext: string;
};

export class VaultError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'VaultError';
  }
}

function toBase64URL(bytes: Uint8Array): string {
  let value = '';
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function fromBase64URL(value: string, length?: number): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) throw new VaultError(502, 'vault_invalid_object');
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(decoded, char => char.charCodeAt(0));
  if (toBase64URL(bytes) !== value || (length !== undefined && bytes.length !== length)) {
    throw new VaultError(502, 'vault_invalid_object');
  }
  return bytes;
}

function assertObjectID(id: string) {
  if (!objectID.test(id)) throw new VaultError(400, 'vault_invalid_id');
}

function parseObject(value: unknown): { salt: Uint8Array<ArrayBuffer>; nonce: Uint8Array<ArrayBuffer>; ciphertext: Uint8Array<ArrayBuffer> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultError(502, 'vault_invalid_object');
  const object = value as Record<string, unknown>;
  if (Object.keys(object).length !== 4 || object.version !== 1 ||
    typeof object.salt !== 'string' || typeof object.nonce !== 'string' || typeof object.ciphertext !== 'string') {
    throw new VaultError(502, 'vault_invalid_object');
  }
  const salt = fromBase64URL(object.salt, 16);
  const nonce = fromBase64URL(object.nonce, 12);
  const ciphertext = fromBase64URL(object.ciphertext);
  if (ciphertext.length < 16 || ciphertext.length > maxCiphertextBytes) throw new VaultError(502, 'vault_invalid_object');
  return { salt, nonce, ciphertext };
}

async function key(passphrase: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, hash: 'SHA-256', iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

function params(id: string, nonce: Uint8Array<ArrayBuffer>): AesGcmParams {
  return { name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`tjuclaw:vault:v1:${id}`) };
}

export async function sealObject(id: string, passphrase: string, plaintext: string): Promise<SealedObject> {
  assertObjectID(id);
  if (!passphrase) throw new VaultError(400, 'vault_passphrase_required');
  const bytes = encoder.encode(plaintext);
  if (bytes.length + 16 > maxCiphertextBytes) throw new VaultError(413, 'vault_object_too_large');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt(params(id, nonce), await key(passphrase, salt), bytes));
  return { version: 1, salt: toBase64URL(salt), nonce: toBase64URL(nonce), ciphertext: toBase64URL(ciphertext) };
}

export async function openObject(id: string, passphrase: string, sealed: unknown): Promise<string> {
  assertObjectID(id);
  if (!passphrase) throw new VaultError(400, 'vault_passphrase_required');
  const { salt, nonce, ciphertext } = parseObject(sealed);
  try {
    const plaintext = await crypto.subtle.decrypt(params(id, nonce), await key(passphrase, salt), ciphertext);
    return decoder.decode(plaintext);
  } catch {
    throw new VaultError(400, 'vault_decryption_failed');
  }
}

function readETag(response: Response): string {
  const etag = response.headers.get('ETag');
  if (!etag || !revisionID.test(etag)) throw new VaultError(502, 'vault_invalid_revision');
  return etag;
}

async function request(id: string, init: RequestInit): Promise<Response> {
  assertObjectID(id);
  const response = await fetch(`/api/vault/objects/${id}`, {
    ...init,
    credentials: 'same-origin',
    cache: 'no-store',
    redirect: 'error',
  });
  if (!response.ok) throw new VaultError(response.status, 'vault_request_failed');
  return response;
}

export async function readVaultObject(id: string, passphrase: string, signal?: AbortSignal): Promise<{ plaintext: string; revision: string }> {
  const response = await request(id, { method: 'GET', headers: { Accept: contentType }, signal });
  if (response.headers.get('Content-Type') !== contentType) throw new VaultError(502, 'vault_invalid_object');
  const revision = readETag(response);
  const sealed: unknown = await response.json();
  return { plaintext: await openObject(id, passphrase, sealed), revision };
}

export async function writeVaultObject(id: string, passphrase: string, plaintext: string, revision?: string, signal?: AbortSignal): Promise<string> {
  if (revision !== undefined && !revisionID.test(revision)) throw new VaultError(400, 'vault_invalid_revision');
  const sealed = await sealObject(id, passphrase, plaintext);
  try {
    const response = await request(id, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        ...(revision === undefined ? { 'If-None-Match': '*' } : { 'If-Match': revision }),
      },
      body: JSON.stringify(sealed),
      signal,
    });
    return readETag(response);
  } catch (error) {
    // A lost response may follow a committed write. Read back the remote
    // plaintext before treating a conflict or gateway failure as a failed save.
    if (signal?.aborted || error instanceof VaultError &&
      error.status !== 409 && error.status !== 502 && error.status !== 503) throw error;
    try {
      const remote = await readVaultObject(id, passphrase, signal);
      if (remote.plaintext === plaintext) return remote.revision;
    } catch { /* Keep the original error when the outcome remains unknown. */ }
    throw error;
  }
}

export async function deleteVaultObject(id: string, revision: string, signal?: AbortSignal): Promise<void> {
  assertObjectID(id);
  if (!revisionID.test(revision)) throw new VaultError(400, 'vault_invalid_revision');
  try {
    const response = await request(id, { method: 'DELETE', headers: { 'If-Match': revision }, signal });
    if (response.status !== 204) throw new VaultError(502, 'vault_invalid_response');
  } catch (error) {
    if (signal?.aborted || error instanceof VaultError &&
      error.status !== 409 && error.status !== 502 && error.status !== 503) throw error;
    // A lost response can mean the object was removed. Do not issue a second DELETE.
    try {
      await request(id, { method: 'GET', headers: { Accept: contentType }, signal });
    } catch (readError) {
      if (readError instanceof VaultError && readError.status === 404) return;
    }
    throw error;
  }
}

import type { CampusCredentials } from './campus-api';

// Opt-in device access, not password protection against someone using this
// browser profile. Never persist the passphrase or plaintext credentials.
export const campusTrustPrefix = 'tjuclaw.campus.device-trust.v1.';
const vaultPrefix = 'tjuclaw.campus.credentials.v1.';
const lifetime = 7 * 24 * 60 * 60 * 1000;
const encoder = new TextEncoder();
type Marker = { token: string; expires: number; ready: boolean };
type RecordValue = Marker & { binding: string; key: CryptoKey; iv: Uint8Array<ArrayBuffer>; data: ArrayBuffer };

function marker(identity: string): Marker | null {
  try {
    const value = JSON.parse(localStorage.getItem(campusTrustPrefix + identity) ?? 'null') as Marker | null;
    return value && typeof value.token === 'string' && Number.isFinite(value.expires) ? value : null;
  } catch { return null; }
}

export function campusTrustExpires(identity: string): number | null {
  const value = marker(identity);
  return value?.ready && value.expires > Date.now() ? value.expires : null;
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('tjuclaw-campus-device-trust', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('accounts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('device storage blocked'));
  });
}

async function readRecord(identity: string): Promise<RecordValue | undefined> {
  const db = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction('accounts', 'readonly');
      const request = transaction.objectStore('accounts').get(identity);
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error);
      transaction.onerror = () => reject(transaction.error);
    });
  } finally { db.close(); }
}

async function binding(identity: string): Promise<string> {
  const envelope = localStorage.getItem(vaultPrefix + identity);
  if (!envelope) throw new Error('missing campus vault');
  const hash = await crypto.subtle.digest('SHA-256', encoder.encode(envelope));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

function matches(identity: string, value: Marker): boolean {
  const now = marker(identity);
  return now?.token === value.token && now.expires === value.expires && value.expires > Date.now();
}

/** Revocation is synchronous; cleanup cannot erase a newer opt-in record. */
export function revokeCampusTrust(identity: string): void {
  try { localStorage.removeItem(campusTrustPrefix + identity); } catch { /* Restoration fails closed. */ }
  void openDatabase().then(db => new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('accounts', 'readwrite');
    const store = transaction.objectStore('accounts');
    const request = store.get(identity);
    request.onsuccess = () => {
      if (!marker(identity) || request.result?.token !== marker(identity)?.token) store.delete(identity);
    };
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onabort = transaction.onerror = () => { db.close(); reject(transaction.error); };
  })).catch(() => undefined);
}

export function revokeAllCampusTrust(): void {
  const identities: string[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (key?.startsWith(campusTrustPrefix)) identities.push(key.slice(campusTrustPrefix.length));
    }
  } catch { /* No readable trust markers means no automatic restoration. */ }
  for (const identity of identities) revokeCampusTrust(identity);
}

export async function rememberCampusDevice(identity: string, credentials: CampusCredentials): Promise<number> {
  const value: Marker = { token: crypto.randomUUID(), expires: Date.now() + lifetime, ready: false };
  // Write before awaiting so lock/logout can cancel a pending operation.
  localStorage.setItem(campusTrustPrefix + identity, JSON.stringify(value));
  try {
    const fingerprint = await binding(identity);
    const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(`${identity}:${value.token}:${value.expires}:${fingerprint}`) },
      key, encoder.encode(JSON.stringify(credentials)),
    );
    const db = await openDatabase();
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = db.transaction('accounts', 'readwrite');
        if (!matches(identity, value)) { db.close(); reject(new Error('device trust cancelled')); return; }
        transaction.objectStore('accounts').put({ ...value, binding: fingerprint, key, iv, data } satisfies RecordValue, identity);
        transaction.oncomplete = () => resolve();
        transaction.onabort = transaction.onerror = () => reject(transaction.error);
      });
    } finally { db.close(); }
    const finalFingerprint = await binding(identity);
    if (!matches(identity, value) || finalFingerprint !== fingerprint) throw new Error('device trust cancelled');
    localStorage.setItem(campusTrustPrefix + identity, JSON.stringify({ ...value, ready: true }));
    return value.expires;
  } catch (error) {
    if (marker(identity)?.token === value.token) revokeCampusTrust(identity);
    throw error;
  }
}

export async function restoreCampusDevice(identity: string): Promise<CampusCredentials | null> {
  const value = marker(identity);
  if (!value?.ready) return null;
  try {
    if (!matches(identity, value)) throw new Error('expired');
    const record = await readRecord(identity);
    const fingerprint = await binding(identity);
    if (!record || record.token !== value.token || record.expires !== value.expires || record.binding !== fingerprint
      || record.key.extractable || !matches(identity, value)) throw new Error('invalid device trust');
    const plaintext = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: record.iv, additionalData: encoder.encode(`${identity}:${value.token}:${value.expires}:${fingerprint}`) },
      record.key, record.data,
    );
    const credentials = JSON.parse(new TextDecoder().decode(plaintext)) as CampusCredentials;
    if (!['wpyUsername', 'wpyPassword', 'officeUsername', 'officePassword'].every(field => typeof credentials[field as keyof CampusCredentials] === 'string')
      || !(credentials.wpyUsername && credentials.wpyPassword || credentials.officeUsername && credentials.officePassword)) throw new Error('invalid credentials');
    const finalFingerprint = await binding(identity);
    return matches(identity, value) && finalFingerprint === fingerprint ? credentials : null;
  } catch {
    if (marker(identity)?.token === value.token) revokeCampusTrust(identity);
    return null;
  }
}

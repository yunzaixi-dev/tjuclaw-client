import type { CampusCredentials } from './campus-api';

const prefix = 'tjuclaw.campus.credentials.v1.';
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Envelope = { version: 1; salt: string; iv: string; data: string };
export type { CampusCredentials } from './campus-api';

function encode(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), character => character.charCodeAt(0));
}

async function derive(passphrase: string, salt: Uint8Array<ArrayBuffer>) {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export function hasCampusCredentials(identity: string): boolean {
  try { return localStorage.getItem(prefix + identity) !== null; } catch { return false; }
}

export async function storeCampusCredentials(identity: string, passphrase: string, credentials: CampusCredentials): Promise<void> {
  if (
    passphrase.length < 12
    || !credentials.wpyUsername.trim()
    || !credentials.wpyPassword
    || !credentials.officeUsername.trim()
    || !credentials.officePassword
  ) throw new Error('请分别填写微北洋账号、办公网账号及密码，并设置至少 12 位的独立解锁口令。');
  if (!crypto.subtle) throw new Error('当前环境不支持安全加密，未保存账号。');
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derive(passphrase, salt);
  const plaintext = encoder.encode(JSON.stringify(credentials));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(identity) },
    key,
    plaintext,
  );
  const envelope: Envelope = { version: 1, salt: encode(salt), iv: encode(iv), data: encode(new Uint8Array(ciphertext)) };
  localStorage.setItem(prefix + identity, JSON.stringify(envelope));
}

export async function unlockCampusCredentials(identity: string, passphrase: string): Promise<CampusCredentials> {
  const stored = localStorage.getItem(prefix + identity);
  if (!stored) throw new Error('本机尚未保存校园账号。');
  const envelope = JSON.parse(stored) as Envelope;
  if (envelope.version !== 1) throw new Error('无法读取此版本的加密账号。');
  const key = await derive(passphrase, decode(envelope.salt));
  const plaintext = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: decode(envelope.iv), additionalData: encoder.encode(identity) },
    key,
    decode(envelope.data),
  );
  const decoded = JSON.parse(decoder.decode(plaintext)) as Partial<CampusCredentials> & { username?: string; password?: string };
  const result: CampusCredentials = {
    wpyUsername: decoded.wpyUsername ?? decoded.username ?? '',
    wpyPassword: decoded.wpyPassword ?? decoded.password ?? '',
    officeUsername: decoded.officeUsername ?? decoded.username ?? '',
    officePassword: decoded.officePassword ?? decoded.password ?? '',
  };
  if (!result.wpyUsername || !result.wpyPassword || !result.officeUsername || !result.officePassword) throw new Error('账号内容无效，请重新分别保存微北洋和办公网账号。');
  return result;
}

export function forgetCampusCredentials(identity: string): void {
  localStorage.removeItem(prefix + identity);
}

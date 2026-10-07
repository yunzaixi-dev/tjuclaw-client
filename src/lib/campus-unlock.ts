import type { CampusCredentials } from './campus-api';
import { campusTrustExpires, campusTrustPrefix, restoreCampusDevice, revokeAllCampusTrust, revokeCampusTrust } from './campus-device-trust';

// Campus accounts are unlocked in Settings and used by the campus tools. The
// decrypted credentials live only in memory, per signed-in identity.

type Listener = (credentials: CampusCredentials | null) => void;

let current: { identity: string; credentials: CampusCredentials } | null = null;
const listeners = new Set<{ identity: string; listener: Listener }>();
let generation = 0;
let verifiedIdentity: string | null = null;
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
const restoring = new Map<string, Promise<void>>();
export const campusUnlockVersion = () => generation;

export function publishCampusCredentials(identity: string, credentials: CampusCredentials | null) {
  generation++;
  if (!credentials) revokeCampusTrust(identity);
  if (credentials || current?.identity === identity) { clearTimeout(expiryTimer); expiryTimer = undefined; }
  current = credentials ? { identity, credentials } : current?.identity === identity ? null : current;
  const expires = credentials ? campusTrustExpires(identity) : null;
  if (expires) expiryTimer = setTimeout(() => publishCampusCredentials(identity, null), Math.max(0, expires - Date.now()));
  for (const entry of listeners) if (entry.identity === identity) entry.listener(credentials);
}

export function lockAllCampusCredentials() {
  generation++;
  verifiedIdentity = null;
  revokeAllCampusTrust();
  if (current) publishCampusCredentials(current.identity, null);
}

/** A cached workspace snapshot is not authority to restore campus secrets. */
export function confirmCampusIdentity(identity: string) {
  verifiedIdentity = identity;
  if (Array.from(listeners).some(entry => entry.identity === identity)) void restoreCampusCredentials(identity);
}

export function restoreCampusCredentials(identity: string): Promise<void> {
  if (verifiedIdentity !== identity) return Promise.resolve();
  if (unlockedCampusCredentials(identity)) return Promise.resolve();
  const pending = restoring.get(identity);
  if (pending) return pending;
  const started = generation;
  const request = restoreCampusDevice(identity).then(credentials => {
    if (credentials && verifiedIdentity === identity && started === generation && campusTrustExpires(identity)
      && Array.from(listeners).some(entry => entry.identity === identity)) publishCampusCredentials(identity, credentials);
  }).finally(() => { restoring.delete(identity); });
  restoring.set(identity, request);
  return request;
}

if (typeof window !== 'undefined') {
  window.addEventListener('storage', event => {
    if (current && (event.key === null || event.key === campusTrustPrefix + current.identity && !event.newValue
      || event.key === 'tjuclaw.campus.credentials.v1.' + current.identity)) publishCampusCredentials(current.identity, null);
    else if (event.key === null || event.key?.startsWith(campusTrustPrefix)) generation++;
  });
  window.addEventListener('focus', () => {
    if (current && expiryTimer && !campusTrustExpires(current.identity)) publishCampusCredentials(current.identity, null);
  });
}

export function unlockedCampusCredentials(identity: string): CampusCredentials | null {
  return current?.identity === identity ? current.credentials : null;
}

/** Calls back on every change for this identity; returns the unsubscribe. */
export function subscribeCampusCredentials(identity: string, listener: Listener): () => void {
  const entry = { identity, listener };
  listeners.add(entry);
  return () => { listeners.delete(entry); };
}

export const hasWpyAccount = (credentials: CampusCredentials | null) => Boolean(credentials?.wpyUsername && credentials.wpyPassword);
export const hasOfficeAccount = (credentials: CampusCredentials | null) => Boolean(credentials?.officeUsername && credentials.officePassword);

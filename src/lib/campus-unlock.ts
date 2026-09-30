import type { CampusCredentials } from './campus-api';

// Campus accounts are unlocked in Settings and used by the campus tools. The
// decrypted credentials live only in memory, per signed-in identity.

type Listener = (credentials: CampusCredentials | null) => void;

let current: { identity: string; credentials: CampusCredentials } | null = null;
const listeners = new Set<{ identity: string; listener: Listener }>();

export function publishCampusCredentials(identity: string, credentials: CampusCredentials | null) {
  current = credentials ? { identity, credentials } : current?.identity === identity ? null : current;
  for (const entry of listeners) if (entry.identity === identity) entry.listener(credentials);
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

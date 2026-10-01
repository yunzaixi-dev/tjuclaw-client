// Note bodies kept on this device, so opening a note does not wait for the
// network. A body is stored with the note's `updated_at`; the tree lists that
// same stamp, so a stored body whose stamp matches the listed one is the
// note as the server last described it. The caller still asks the server
// afterwards and swaps in a newer body if there is one.
//
// Memory answers at once; SQLite on OPFS (or the native store) carries the
// bodies across visits. The database is opened only after the workspace is on
// screen (or when a note is first opened by hand), so it never adds to the
// first load. Bodies are stored as they are: this device is the user's own,
// and signing out clears them.
import { getEntry, type Entry } from './library';
import { openLocalStore, type LocalStore } from './local-store.ts';

const memory = new Map<string, Entry>();
/** Notes remembered before the database was opened, written once it is. */
const unsaved = new Set<string>();
let owner: string | null = null;
let loaded: Promise<void> | null = null;
let store: Promise<LocalStore | null> | null = null;

const namespace = (identity: string) => `entries:${identity}`;
const cacheable = (entry: Entry) => entry.kind === 'note' && typeof entry.body === 'string';

function persistent(): Promise<LocalStore | null> {
  // localStorage has a few megabytes for everything; bodies stay in memory there.
  store ??= openLocalStore().then(opened => opened.engine === 'local-storage' ? null : opened, () => null);
  return store;
}

/** Selects whose notes this cache holds; nothing is read from disk yet. */
export function openEntryCache(identity: string) {
  if (owner === identity) return;
  owner = identity;
  memory.clear();
  unsaved.clear();
  loaded = null;
}

/** Opens the database and reads this identity's stored bodies into memory. Idempotent. */
export function hydrateEntryCache(): Promise<void> {
  const identity = owner;
  if (!identity) return Promise.resolve();
  loaded ??= (async () => {
    const opened = await persistent();
    if (!opened || owner !== identity) return;
    for (const [id, value] of await opened.list(namespace(identity)).catch(() => [])) {
      if (owner !== identity) return;
      try {
        const entry = JSON.parse(value) as Entry;
        if (entry?.id === id && cacheable(entry) && !memory.has(id)) memory.set(id, entry);
      } catch { /* an unreadable row is simply not used */ }
    }
    for (const id of [...unsaved]) {
      unsaved.delete(id);
      const entry = memory.get(id);
      if (entry) await opened.set(namespace(identity), id, JSON.stringify(entry)).catch(() => undefined);
    }
  })();
  return loaded;
}

/** The stored note for a listed entry, if it is the same revision. */
export function cachedEntry(listed: Entry): Entry | null {
  const entry = memory.get(listed.id);
  return entry && entry.updated_at === listed.updated_at ? entry : null;
}

/**
 * As cachedEntry, waiting briefly for the read from disk. With `hydrate` the
 * database is opened if it is not yet; during the first load it is left alone.
 */
export async function cachedEntryWhenReady(listed: Entry, hydrate: boolean, waitMs = 250): Promise<Entry | null> {
  const found = cachedEntry(listed);
  if (found) return found;
  const reading = hydrate ? hydrateEntryCache() : loaded;
  if (!reading) return null;
  await Promise.race([reading, new Promise(resolve => setTimeout(resolve, waitMs))]);
  return cachedEntry(listed);
}

/** Keeps a note's body (as returned by the server) for later opens. */
export function rememberEntry(entry: Entry) {
  const identity = owner;
  if (!identity || !cacheable(entry)) return;
  memory.set(entry.id, entry);
  if (!loaded) { unsaved.add(entry.id); return; }
  void persistent().then(opened => opened?.set(namespace(identity), entry.id, JSON.stringify(entry))).catch(() => undefined);
}

/** Drops stored notes that no longer exist in the tree. */
export function pruneEntryCache(listed: Entry[]) {
  const identity = owner;
  if (!identity) return;
  const ids = new Set(listed.map(entry => entry.id));
  for (const id of [...memory.keys()]) if (!ids.has(id)) { memory.delete(id); unsaved.delete(id); }
  // Rows on disk are pruned once the database has been read.
  void (loaded ?? Promise.resolve()).then(async () => {
    if (!loaded) return;
    if (owner !== identity) return;
    const opened = await persistent();
    for (const id of [...memory.keys()]) {
      if (ids.has(id)) continue;
      memory.delete(id);
      await opened?.delete(namespace(identity), id).catch(() => undefined);
    }
  });
}

/** Forgets every stored note of the current identity (sign-out, another account). */
export function clearEntryCache() {
  const identity = owner;
  owner = null;
  memory.clear();
  unsaved.clear();
  loaded = null;
  if (!identity) return;
  void persistent().then(async opened => {
    if (!opened) return;
    for (const [id] of await opened.list(namespace(identity))) await opened.delete(namespace(identity), id);
  }).catch(() => undefined);
}

const inflight = new Map<string, Promise<Entry>>();
const loadedAt = new Map<string, number>();

/** True when the server's copy was read moments ago, so asking again would tell nothing new. */
export const justLoaded = (id: string, withinMs = 10_000) => Date.now() - (loadedAt.get(id) ?? 0) < withinMs;

/**
 * Reads a note from the server and keeps it. One request per note at a time:
 * pointing at a note starts it and the click that follows waits for the same one.
 */
export function loadEntry(id: string): Promise<Entry> {
  let request = inflight.get(id);
  if (!request) {
    const identity = owner;
    request = getEntry(id).then(entry => {
      if (owner === identity) { rememberEntry(entry); loadedAt.set(id, Date.now()); }
      return entry;
    }).finally(() => { inflight.delete(id); });
    inflight.set(id, request);
  }
  return request;
}

/** Starts loading a listed note that is not on this device yet. */
export function warmEntry(listed: Entry) {
  if (listed.kind !== 'note' || listed.body !== undefined || cachedEntry(listed)) return;
  void loadEntry(listed.id).catch(() => undefined);
}

// Note bodies kept on this device, so opening a note does not wait for the
// network. A body is stored with the note's `updated_at`; the tree lists that
// same stamp, so a stored body whose stamp matches the listed one is current
// and must not be fetched again. A different stamp is shown at once, then
// refreshed. A Git blob written after the workspace is on screen is the
// fallback when this cache misses. The first screen does not open the store.
//
// Memory answers at once; SQLite on OPFS (or the native store) carries the
// bodies across visits. The database is opened only after the workspace is on
// screen (or when a note is first opened by hand), so it never adds to the
// first load. Bodies are stored as they are: this device is the user's own,
// and signing out clears them.
import { clearGitEntries, readGitEntry, rememberGitEntry } from './git/entry-replica.ts';
import { getEntry, type Entry } from './library';
import { openLocalStore, type LocalStore } from './local-store.ts';

const memory = new Map<string, Entry>();
/** Notes remembered before the database was opened, written once it is. */
const unsaved = new Set<string>();
let owner: string | null = null;
let loaded: Promise<void> | null = null;
let store: Promise<LocalStore | null> | null = null;

const namespace = (identity: string) => `entries:${identity}`;
const cacheable = (entry: Entry) => (entry.kind === 'note' || entry.kind === 'rich_text') && typeof entry.body === 'string';

// A synchronous copy so opening a note never waits on SQLite, Git, or the
// network. The database still holds the full set; this mirror is what the
// click handler can read before the first await. Large bodies stay in SQLite.
const MIRROR_BUDGET = 1_500_000;
const MIRROR_NOTE_LIMIT = 180_000;
const mirrorKey = (identity: string) => `tjuclaw.note-mirror.v1.${identity}`;
type Mirror = { order: string[]; notes: Record<string, Entry> };
let mirrorCache: { identity: string; data: Mirror } | null = null;

function browserStorage(): Storage | null {
  try { return globalThis.localStorage ?? null; } catch { return null; }
}

function emptyMirror(): Mirror { return { order: [], notes: {} }; }

function readMirror(identity: string): Mirror {
  if (mirrorCache?.identity === identity) return mirrorCache.data;
  const storage = browserStorage();
  let data = emptyMirror();
  try {
    const parsed = JSON.parse(storage?.getItem(mirrorKey(identity)) ?? '') as Mirror;
    if (parsed && typeof parsed.notes === 'object' && Array.isArray(parsed.order)) data = parsed;
  } catch { /* an unreadable mirror is simply not used */ }
  mirrorCache = { identity, data };
  return data;
}

function writeMirror(identity: string, entry: Entry) {
  if (!cacheable(entry) || entry.body!.length > MIRROR_NOTE_LIMIT) return;
  const storage = browserStorage();
  if (!storage) return;
  const data = readMirror(identity);
  const kept: Entry = {
    id: entry.id, library_id: entry.library_id, parent_id: entry.parent_id, kind: entry.kind,
    title: entry.title, body: entry.body, created_at: entry.created_at, updated_at: entry.updated_at,
  };
  data.notes[entry.id] = kept;
  data.order = [entry.id, ...data.order.filter(id => id !== entry.id)];
  const persist = () => {
    while (data.order.length > 1 && JSON.stringify(data).length > MIRROR_BUDGET) {
      const drop = data.order.pop();
      if (drop) delete data.notes[drop];
    }
    storage.setItem(mirrorKey(identity), JSON.stringify(data));
  };
  try { persist(); } catch {
    const drop = data.order.pop();
    if (drop) delete data.notes[drop];
    try { persist(); } catch { /* quota: memory still has the body */ }
  }
}

function dropMirror(identity: string, id?: string) {
  const storage = browserStorage();
  if (!storage) return;
  if (!id) {
    mirrorCache = null;
    try { storage.removeItem(mirrorKey(identity)); } catch { /* already gone */ }
    return;
  }
  const data = readMirror(identity);
  if (!data.notes[id]) return;
  delete data.notes[id];
  data.order = data.order.filter(item => item !== id);
  try { storage.setItem(mirrorKey(identity), JSON.stringify(data)); } catch { /* keep memory */ }
}

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
        if (entry?.id === id && cacheable(entry) && !memory.has(id)) {
          memory.set(id, entry);
          writeMirror(identity, entry);
        }
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
  const entry = memory.get(listed.id) ?? (owner ? readMirror(owner).notes[listed.id] : undefined);
  return entry && entry.updated_at === listed.updated_at ? entry : null;
}

/**
 * The note this browser can show before any await. Memory first, then the
 * localStorage mirror. `fresh` means the tree's revision matches, so the
 * caller must not GET. An older body is still returned so the page can open
 * and refresh afterwards.
 */
export function peekNote(listed: Entry): { entry: Entry; fresh: boolean } | null {
  const stored = withBody(memory.get(listed.id)) ?? (owner ? withBody(readMirror(owner).notes[listed.id]) : null);
  if (!stored) return null;
  if (!memory.has(stored.id)) memory.set(stored.id, stored);
  return { entry: stored, fresh: stored.updated_at === listed.updated_at };
}

const withBody = (entry: Entry | null | undefined) => entry && typeof entry.body === 'string' ? entry : null;

/**
 * The note on this device, even when its revision is older than the tree.
 * `fresh` means the tree's `updated_at` matches, so the caller must not GET.
 * With `hydrate` the database is opened if needed and waited on, up to
 * `waitMs`. During the first load, pass hydrate false so the screen does not
 * open the store; an already-started read is still awaited.
 */
export async function localNote(listed: Entry, hydrate: boolean, waitMs = 1500): Promise<{ entry: Entry; fresh: boolean } | null> {
  const pick = (entry: Entry | null | undefined) => {
    const body = withBody(entry);
    return body ? { entry: body, fresh: body.updated_at === listed.updated_at } : null;
  };
  const ready = peekNote(listed);
  if (ready) return ready;
  const reading = hydrate ? hydrateEntryCache() : loaded;
  if (reading) await Promise.race([reading, new Promise(resolve => setTimeout(resolve, waitMs))]);
  const stored = pick(memory.get(listed.id));
  if (stored) return stored;
  if (!hydrate || !owner) return null;
  const git = await Promise.race([
    readGitEntry(owner, listed.id).catch(() => null),
    new Promise<null>(resolve => setTimeout(() => resolve(null), Math.min(waitMs, 800))),
  ]);
  const gitHit = pick(git);
  if (!gitHit) return null;
  memory.set(gitHit.entry.id, gitHit.entry);
  return gitHit;
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

let replica = false;

/** After the workspace is on screen, also keep bodies as Git blobs. */
export function enableEntryReplica() {
  replica = true;
  const identity = owner;
  if (!identity) return;
  for (const entry of memory.values()) void rememberGitEntry(identity, entry).catch(() => undefined);
}

/** Keeps a note's body (as returned by the server) for later opens. */
export function rememberEntry(entry: Entry) {
  const identity = owner;
  if (!identity || !cacheable(entry)) return;
  memory.set(entry.id, entry);
  writeMirror(identity, entry);
  if (replica) void rememberGitEntry(identity, entry).catch(() => undefined);
  // The idle hydrate opens the database. Starting it here would download the
  // SQLite worker before the first note is on screen.
  if (!loaded) { unsaved.add(entry.id); return; }
  void persistent().then(opened => opened?.set(namespace(identity), entry.id, JSON.stringify(entry))).catch(() => undefined);
}

/** Drops stored notes that no longer exist in the tree. */
export function pruneEntryCache(listed: Entry[]) {
  const identity = owner;
  if (!identity) return;
  const ids = new Set(listed.map(entry => entry.id));
  for (const id of [...memory.keys()]) if (!ids.has(id)) { memory.delete(id); unsaved.delete(id); dropMirror(identity, id); }
  for (const id of [...readMirror(identity).order]) if (!ids.has(id)) dropMirror(identity, id);
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

export type WorkspaceTree = {
  library: { id: string; name: string; created_at: string; updated_at: string };
  entries: Entry[];
  verification: 'local' | 'remote';
  /** Last surface this browser showed: the notes home, or a note id. */
  focus?: 'home' | string;
};
const treeKey = (identity: string) => `tjuclaw.workspace-tree.v1.${identity}`;

function bareEntry(entry: Entry): Entry {
  const copy = { ...entry };
  delete copy.body;
  return copy;
}

/** The last workspace tree this browser showed, without note bodies. */
export function readWorkspaceTree(identity: string): WorkspaceTree | null {
  const storage = browserStorage();
  if (!storage) return null;
  try {
    const parsed = JSON.parse(storage.getItem(treeKey(identity)) ?? '') as WorkspaceTree;
    if (!parsed || parsed.verification !== 'local' && parsed.verification !== 'remote') return null;
    if (!parsed.library || typeof parsed.library.id !== 'string' || typeof parsed.library.name !== 'string') return null;
    if (!Array.isArray(parsed.entries)) return null;
    const entries = parsed.entries.filter(entry => entry && typeof entry.id === 'string' && typeof entry.kind === 'string' && typeof entry.title === 'string' && typeof entry.updated_at === 'string');
    if (!entries.length) return null;
    return {
      library: {
        id: parsed.library.id,
        name: parsed.library.name,
        created_at: typeof parsed.library.created_at === 'string' ? parsed.library.created_at : '',
        updated_at: typeof parsed.library.updated_at === 'string' ? parsed.library.updated_at : '',
      },
      entries: entries.map(bareEntry),
      verification: parsed.verification,
      focus: parsed.focus === 'home' || typeof parsed.focus === 'string' ? parsed.focus : undefined,
    };
  } catch { return null; }
}

/** Remembers the tree so the next visit can paint before the network answers. */
export function writeWorkspaceTree(identity: string, tree: WorkspaceTree) {
  const storage = browserStorage();
  if (!storage || !tree.entries.length) return;
  const payload: WorkspaceTree = {
    library: tree.library,
    entries: tree.entries.slice(0, 800).map(bareEntry),
    verification: tree.verification,
    focus: tree.focus === 'home' || typeof tree.focus === 'string' ? tree.focus : undefined,
  };
  const persist = () => storage.setItem(treeKey(identity), JSON.stringify(payload));
  try { persist(); } catch {
    payload.entries = payload.entries.slice(0, 80);
    try { persist(); } catch { /* individual notes still open from the mirror */ }
  }
}

export function dropWorkspaceTree(identity: string) {
  try { browserStorage()?.removeItem(treeKey(identity)); } catch { /* already gone */ }
}

/**
 * The listed row plus a cached body when this device already has that revision.
 * A miss stays body-less so the caller can show an older copy, then refresh.
 */
export function listedWithCache(entry: Entry): Entry {
  if ((entry.kind !== 'note' && entry.kind !== 'rich_text') || typeof entry.body === 'string') return entry;
  const local = peekNote(entry);
  // A stale body still paints at once. The caller compares updated_at and refreshes.
  return local && typeof local.entry.body === 'string' ? { ...entry, body: local.entry.body } : entry;
}

/** Forgets every stored note of the current identity (sign-out, another account). */
export function clearEntryCache() {
  const identity = owner;
  owner = null;
  memory.clear();
  unsaved.clear();
  loaded = null;
  replica = false;
  mirrorCache = null;
  if (!identity) return;
  dropMirror(identity);
  dropWorkspaceTree(identity);
  void clearGitEntries(identity).catch(() => undefined);
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
  // Two callers can ask one after the other instead of at once: pointing at a
  // note finishes its read just before the click's own begins. The copy read
  // a moment ago is the answer to both.
  const recent = !request && justLoaded(id, 1000) ? memory.get(id) : undefined;
  if (recent) return Promise.resolve(recent);
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

/**
 * Starts loading a listed note that is not on this device yet.
 * Hover and focus must not fetch a body the SQLite or Git cache already has;
 * a matching revision is opened locally, and an older one is refreshed on open.
 */
export function warmEntry(listed: Entry) {
  if ((listed.kind !== 'note' && listed.kind !== 'rich_text') || listed.body !== undefined || cachedEntry(listed) || peekNote(listed)) return;
  void (async () => {
    const local = await localNote(listed, true, 1500);
    if (local || cachedEntry(listed) || memory.has(listed.id)) return;
    if (loaded) {
      await loaded.catch(() => undefined);
      if (owner && (cachedEntry(listed) || memory.has(listed.id))) return;
    }
    await loadEntry(listed.id);
  })().catch(() => undefined);
}

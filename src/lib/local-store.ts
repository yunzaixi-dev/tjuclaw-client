// One device-local store for every platform: SQLite on OPFS in browsers (via
// a worker), native SQLite in the Tauri shell, and localStorage only where
// neither exists (old Safari, blocked storage). Values are opaque strings;
// anything private must be encrypted by the caller first.
import { invoke, isTauri } from '@tauri-apps/api/core';

/** One Git object as the database stores it. */
export type GitRow = { oid: string; type: string; data: Uint8Array };
export type StoreRequest =
  | { id: string; op: 'get' | 'delete'; ns: string; key: string }
  | { id: string; op: 'set'; ns: string; key: string; value: string }
  | { id: string; op: 'list'; ns: string }
  // Git replicas (src/lib/git): objects and refs of one repository per `repo` key.
  | { id: string; op: 'git-read'; repo: string; oid: string }
  | { id: string; op: 'git-write'; repo: string; objects: GitRow[] }
  | { id: string; op: 'git-ref-get'; repo: string; name: string }
  | { id: string; op: 'git-ref-set'; repo: string; name: string; oid: string }
  | { id: string; op: 'git-clear'; repo: string };
export type StoreRequestBody = StoreRequest extends infer R ? R extends StoreRequest ? Omit<R, 'id'> : never : never;
type RequestBody = StoreRequestBody;
export type StoreResult = string | null | [string, string][] | { type: string; data: Uint8Array };
export type StoreResponse =
  | { id: string; ok: true; result: StoreResult }
  | { id: string; ok: false; error: string };

export type LocalStore = {
  readonly engine: 'sqlite-opfs' | 'sqlite-native' | 'local-storage';
  get(ns: string, key: string): Promise<string | null>;
  set(ns: string, key: string, value: string): Promise<void>;
  delete(ns: string, key: string): Promise<void>;
  list(ns: string): Promise<[string, string][]>;
  /** The database worker itself, present only for SQLite on OPFS. */
  readonly worker?: (request: StoreRequestBody) => Promise<StoreResult>;
};

const MAX_NAME = 256;
const MAX_VALUE = 4 << 20;
const REQUEST_TIMEOUT_MS = 10_000;

function checkName(ns: string, key?: string) {
  const bad = (value: string) => !value || value.length > MAX_NAME;
  if (bad(ns) || (key !== undefined && bad(key))) throw new Error('store_invalid_key');
}

function nativeStore(): LocalStore {
  return {
    engine: 'sqlite-native',
    get: (ns, key) => (checkName(ns, key), invoke<string | null>('store_get', { ns, key })),
    set: async (ns, key, value) => {
      checkName(ns, key);
      if (value.length > MAX_VALUE) throw new Error('store_value_too_large');
      await invoke('store_set', { ns, key, value });
    },
    delete: async (ns, key) => { checkName(ns, key); await invoke('store_delete', { ns, key }); },
    list: ns => (checkName(ns), invoke<[string, string][]>('store_list', { ns })),
  };
}

/** Namespaced localStorage, kept for browsers without OPFS sync access. */
export function localStorageStore(storage: Storage = localStorage): LocalStore {
  const prefix = (ns: string) => `tjuclaw.store.${ns}.`;
  return {
    engine: 'local-storage',
    get: async (ns, key) => (checkName(ns, key), storage.getItem(prefix(ns) + key)),
    set: async (ns, key, value) => {
      checkName(ns, key);
      if (value.length > MAX_VALUE) throw new Error('store_value_too_large');
      storage.setItem(prefix(ns) + key, value);
    },
    delete: async (ns, key) => { checkName(ns, key); storage.removeItem(prefix(ns) + key); },
    list: async ns => {
      checkName(ns);
      const rows: [string, string][] = [];
      for (let index = 0; index < storage.length; index++) {
        const name = storage.key(index);
        if (name?.startsWith(prefix(ns))) rows.push([name.slice(prefix(ns).length), storage.getItem(name) ?? '']);
      }
      return rows.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    },
  };
}

function opfsSupported() {
  return typeof Worker !== 'undefined' && typeof BroadcastChannel !== 'undefined' &&
    typeof navigator !== 'undefined' && 'locks' in navigator && typeof navigator.storage?.getDirectory === 'function';
  // Sync access handles exist only inside workers; the worker reports
  // "unavailable" when it cannot open the pool.
}

/** Resolves once this tab's worker is ready or knows another tab leads. */
function workerStore(): Promise<LocalStore | null> {
  const worker = new Worker(new URL('./local-store-worker.ts', import.meta.url), { type: 'module', name: 'tjuclaw-local-store' });
  const waiting = new Map<string, { resolve: (value: StoreResponse) => void; timer: number }>();
  let counter = 0;
  const call = (request: RequestBody) => new Promise<StoreResponse>((resolve, reject) => {
    const id = `${Date.now().toString(36)}-${(counter++).toString(36)}-${Math.random().toString(36).slice(2)}`;
    const timer = window.setTimeout(() => { waiting.delete(id); reject(new Error('store_timeout')); }, REQUEST_TIMEOUT_MS);
    waiting.set(id, { resolve, timer });
    worker.postMessage({ ...request, id } as StoreRequest);
  });
  const result = async (request: RequestBody) => {
    const response = await call(request);
    if (!response.ok) throw new Error(response.error);
    return response.result;
  };
  const store: LocalStore = {
    engine: 'sqlite-opfs',
    get: async (ns, key) => (checkName(ns, key), await result({ op: 'get', ns, key }) as string | null),
    set: async (ns, key, value) => {
      checkName(ns, key);
      if (value.length > MAX_VALUE) throw new Error('store_value_too_large');
      await result({ op: 'set', ns, key, value });
    },
    delete: async (ns, key) => { checkName(ns, key); await result({ op: 'delete', ns, key }); },
    list: async ns => (checkName(ns), await result({ op: 'list', ns }) as [string, string][]),
    worker: result,
  };
  return new Promise(resolve => {
    let settled = false;
    const finish = (value: LocalStore | null) => {
      if (settled) return;
      settled = true;
      if (!value) worker.terminate();
      resolve(value);
    };
    worker.onmessage = (event: MessageEvent<StoreResponse | { type: 'ready' | 'unavailable' }>) => {
      const data = event.data;
      if ('type' in data) {
        finish(data.type === 'ready' ? store : null);
        return;
      }
      const entry = waiting.get(data.id);
      if (!entry) return;
      waiting.delete(data.id);
      window.clearTimeout(entry.timer);
      entry.resolve(data);
    };
    worker.onerror = () => finish(null);
    // A follower tab never becomes ready while another tab leads; probe the
    // leader instead of waiting for the lock. No answer at all means no tab
    // could open OPFS; fall back rather than hang.
    void result({ op: 'list', ns: 'meta' }).then(() => finish(store), () => finish(null));
  });
}

let opened: Promise<LocalStore> | null = null;

/** The device-local store for this platform (opened once per page). */
export function openLocalStore(): Promise<LocalStore> {
  opened ??= (async () => {
    if (isTauri()) {
      const store = nativeStore();
      if (await store.list('meta').then(() => true, () => false)) return store;
      return localStorageStore();
    }
    if (opfsSupported()) {
      const store = await workerStore().catch(() => null);
      if (store) return store;
    }
    return localStorageStore();
  })();
  return opened;
}

/**
 * One-time copy of legacy localStorage keys into the store. Each migrated key
 * is recorded so a later run never overwrites newer store values.
 */
export async function importLegacyLocalStorage(store: LocalStore, ns: string, keys: string[], storage: Storage = localStorage) {
  let imported = 0;
  for (const key of keys) {
    const value = storage.getItem(key);
    if (value === null || await store.get('migrated', `${ns}:${key}`) !== null) continue;
    await store.set(ns, key, value);
    await store.set('migrated', `${ns}:${key}`, String(Date.now()));
    imported++;
  }
  return imported;
}

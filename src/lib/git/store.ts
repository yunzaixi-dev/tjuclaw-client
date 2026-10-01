// Where a repository's objects and refs live on this device. The pack reader
// and the sync loop only see this interface; SQLite on OPFS implements it in
// the browser and a Map implements it for tests.
import type { GitObject, GitType } from './pack.ts';

export interface GitStore {
  getRef(name: string): Promise<string | null>;
  setRef(name: string, oid: string): Promise<void>;
  read(oid: string): Promise<{ type: GitType; data: Uint8Array } | null>;
  /** Adds objects; one already present is left as it is. */
  write(objects: GitObject[]): Promise<void>;
}

export function memoryStore(): GitStore & { size(): number } {
  const objects = new Map<string, { type: GitType; data: Uint8Array }>();
  const refs = new Map<string, string>();
  return {
    getRef: async name => refs.get(name) ?? null,
    setRef: async (name, oid) => { refs.set(name, oid); },
    read: async oid => objects.get(oid) ?? null,
    write: async list => { for (const { oid, type, data } of list) if (!objects.has(oid)) objects.set(oid, { type, data }); },
    size: () => objects.size,
  };
}

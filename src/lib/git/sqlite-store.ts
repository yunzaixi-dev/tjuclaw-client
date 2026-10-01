// The Git replica on this device: objects and refs in the same SQLite
// database on OPFS that holds the rest of the device-local state.
import { openLocalStore, type GitRow } from '../local-store.ts';
import type { GitType } from './pack.ts';
import type { GitStore } from './store.ts';

const OID = /^[0-9a-f]{40}$/;
// Batches keep one worker message well under the request timeout.
const BATCH_BYTES = 4 << 20;
const BATCH_OBJECTS = 500;

/**
 * Opens the replica for one repository key, or returns null where SQLite on
 * OPFS is unavailable (the native shell and old browsers read from the server).
 */
export async function openGitStore(repo: string): Promise<(GitStore & { clear(): Promise<void> }) | null> {
  if (!repo || repo.length > 256) throw new Error('git_store_invalid_repo');
  const { worker } = await openLocalStore();
  if (!worker) return null;
  const oidOf = (oid: string) => { if (!OID.test(oid)) throw new Error('git_store_invalid_oid'); return oid; };
  return {
    getRef: async name => await worker({ op: 'git-ref-get', repo, name }) as string | null,
    setRef: async (name, oid) => { await worker({ op: 'git-ref-set', repo, name, oid: oidOf(oid) }); },
    read: async oid => await worker({ op: 'git-read', repo, oid: oidOf(oid) }) as { type: GitType; data: Uint8Array } | null,
    write: async objects => {
      let batch: GitRow[] = [];
      let bytes = 0;
      for (const { oid, type, data } of objects) {
        batch.push({ oid: oidOf(oid), type, data });
        bytes += data.length;
        if (bytes >= BATCH_BYTES || batch.length >= BATCH_OBJECTS) {
          await worker({ op: 'git-write', repo, objects: batch });
          batch = [];
          bytes = 0;
        }
      }
      if (batch.length) await worker({ op: 'git-write', repo, objects: batch });
    },
    clear: async () => { await worker({ op: 'git-clear', repo }); },
  };
}

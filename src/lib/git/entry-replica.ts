// A device-local Git blob of a note body, so opening a note can use the replica
// when the SQLite body cache misses. This is not a full repository sync: the
// browser has no Git smart HTTP, and the first screen must not open the store.
import type { Entry } from '../library';
import { openGitStore } from './sqlite-store.ts';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const repoKey = (identity: string) => `notes-cache:${identity}`;
const refName = (id: string) => `refs/tjuclaw/entries/${id}`;

export async function readGitEntry(identity: string, id: string): Promise<Entry | null> {
  const store = await openGitStore(repoKey(identity));
  if (!store) return null;
  const oid = await store.getRef(refName(id));
  if (!oid) return null;
  const object = await store.read(oid);
  if (!object || object.type !== 'blob') return null;
  try {
    const parsed = JSON.parse(decoder.decode(object.data)) as Partial<Entry>;
    if (parsed.id !== id || typeof parsed.body !== 'string' || typeof parsed.updated_at !== 'string') return null;
    return {
      id,
      library_id: '',
      parent_id: '',
      kind: 'note',
      title: typeof parsed.title === 'string' ? parsed.title : '',
      body: parsed.body,
      created_at: parsed.updated_at,
      updated_at: parsed.updated_at,
    };
  } catch {
    return null;
  }
}

export async function rememberGitEntry(identity: string, entry: Entry): Promise<void> {
  if (!identity || entry.kind !== 'note' || typeof entry.body !== 'string') return;
  const store = await openGitStore(repoKey(identity));
  if (!store) return;
  const { objectId } = await import('./pack.ts');
  const data = encoder.encode(JSON.stringify({ id: entry.id, title: entry.title, updated_at: entry.updated_at, body: entry.body }));
  const oid = await objectId('blob', data);
  await store.write([{ oid, type: 'blob', data }]);
  await store.setRef(refName(entry.id), oid);
}

export async function clearGitEntries(identity: string): Promise<void> {
  if (!identity) return;
  const store = await openGitStore(repoKey(identity));
  await store?.clear();
}

// A local replica of one remote branch: sync brings the objects down, and the
// readers answer from the device without the network.
import { parsePack, type GitType } from './pack.ts';
import { fetchPack, listRefs, type GitTransport } from './protocol.ts';
import type { GitStore } from './store.ts';

export interface Commit { oid: string; tree: string; parents: string[]; author: string; date: string; message: string }
export interface TreeEntry { mode: string; name: string; oid: string }
export interface SyncResult { head: string | null; changed: boolean; objects: number; packBytes: number }

const decoder = new TextDecoder();
const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

/** Downloads what the remote branch has that this device lacks, then moves the local ref. */
export async function syncRepo(store: GitStore, transport: GitTransport, ref = 'refs/heads/main'): Promise<SyncResult> {
  const remote = (await listRefs(transport, [ref])).get(ref) ?? null;
  const local = await store.getRef(ref);
  if (!remote || remote === local) return { head: remote ?? local, changed: false, objects: 0, packBytes: 0 };
  const pack = await fetchPack(transport, [remote], local ? [local] : []);
  const objects = await parsePack(pack, oid => store.read(oid));
  // Objects first: a ref must never point at history that is not stored yet.
  await store.write(objects);
  await store.setRef(ref, remote);
  return { head: remote, changed: true, objects: objects.length, packBytes: pack.length };
}

async function readObject(store: GitStore, oid: string, type: GitType): Promise<Uint8Array> {
  const object = await store.read(oid);
  if (!object || object.type !== type) throw new Error('git_object_missing');
  return object.data;
}

export async function readCommit(store: GitStore, oid: string): Promise<Commit> {
  const text = decoder.decode(await readObject(store, oid, 'commit'));
  const split = text.indexOf('\n\n');
  const headers = (split < 0 ? text : text.slice(0, split)).split('\n');
  const commit: Commit = { oid, tree: '', parents: [], author: '', date: '', message: split < 0 ? '' : text.slice(split + 2) };
  for (const line of headers) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5);
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7));
    else if (line.startsWith('author ')) {
      const match = line.match(/^author (.*) <[^>]*> (\d+) [+-]\d{4}$/);
      if (match) { commit.author = match[1]!; commit.date = new Date(Number(match[2]) * 1000).toISOString(); }
    }
  }
  if (!commit.tree) throw new Error('git_commit_invalid');
  return commit;
}

export async function readTree(store: GitStore, oid: string): Promise<TreeEntry[]> {
  const data = await readObject(store, oid, 'tree');
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0, space);
    if (space < 0 || nul < 0 || nul + 21 > data.length) throw new Error('git_tree_invalid');
    entries.push({
      mode: decoder.decode(data.subarray(offset, space)),
      name: decoder.decode(data.subarray(space + 1, nul)),
      oid: hex(data.subarray(nul + 1, nul + 21)),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Every file under a tree, path → blob. */
export async function listFiles(store: GitStore, tree: string, prefix = ''): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const entry of await readTree(store, tree)) {
    const path = prefix + entry.name;
    if (entry.mode === '40000') for (const [name, oid] of await listFiles(store, entry.oid, `${path}/`)) files.set(name, oid);
    else if (entry.mode !== '160000') files.set(path, entry.oid);
  }
  return files;
}

export const readBlob = (store: GitStore, oid: string) => readObject(store, oid, 'blob');
export const readText = async (store: GitStore, oid: string) => decoder.decode(await readBlob(store, oid));

/** The blob at a path in a tree, or null when the path is absent. */
export async function blobAt(store: GitStore, tree: string, path: string): Promise<string | null> {
  let current = tree;
  const parts = path.split('/');
  for (let index = 0; index < parts.length; index++) {
    const entry = (await readTree(store, current)).find(item => item.name === parts[index]);
    if (!entry) return null;
    if (index === parts.length - 1) return entry.mode === '40000' ? null : entry.oid;
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** The commits that changed one file, newest first, following first parents. */
export async function fileHistory(store: GitStore, head: string, path: string, limit = 50): Promise<Commit[]> {
  const history: Commit[] = [];
  let commit = await readCommit(store, head);
  let blob = await blobAt(store, commit.tree, path);
  while (history.length < limit) {
    const parentOid: string | undefined = commit.parents[0];
    const parent = parentOid ? await readCommit(store, parentOid) : null;
    const before = parent ? await blobAt(store, parent.tree, path) : null;
    if (blob !== before) history.push(commit);
    if (!parent) break;
    commit = parent;
    blob = before;
  }
  return history;
}

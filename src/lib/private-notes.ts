import { deleteVaultObject, readVaultObject, VaultError, writeVaultObject } from './sealed-vault';

const encoder = new TextEncoder();
const WORKSPACE_ID = /^[0-9a-f]{32}$/;
const NOTE_ID = /^[0-9a-f]{32}$/;
const REVISION = /^"[0-9a-f]{40}"$/;
const MAX_NOTES = 200;
const MAX_PENDING_DELETES = 200;
const MAX_BODY_BYTES = 80 << 10;

export type PrivateNote = { id: string; title: string; legacy_entry_id?: string };
export type PrivateNotebook = {
  notes: PrivateNote[];
  pendingDeletes: { id: string; revision: string }[];
  revision?: string;
};

function validWorkspace(id: string) {
  if (!WORKSPACE_ID.test(id)) throw new VaultError(400, 'private_workspace_invalid');
}

export async function privateNotebookID(workspaceId: string): Promise<string> {
  validWorkspace(workspaceId);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256',
    encoder.encode(`tjuclaw:private-notebook:v1:${workspaceId}`)));
  return [...digest.slice(0, 16)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function parseNotebook(plaintext: string, workspaceId: string, revision: string): PrivateNotebook {
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { throw new VaultError(502, 'private_notebook_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultError(502, 'private_notebook_invalid');
  const record = value as Record<string, unknown>;
  if (!Object.keys(record).every(key => ['version', 'workspace_id', 'notes', 'pending_deletes'].includes(key)) ||
    Object.keys(record).length !== (record.pending_deletes === undefined ? 3 : 4) ||
    record.version !== 1 || record.workspace_id !== workspaceId ||
    !Array.isArray(record.notes) || record.notes.length > MAX_NOTES || !REVISION.test(revision)) {
    throw new VaultError(502, 'private_notebook_invalid');
  }
  const seen = new Set<string>();
  for (const note of record.notes) {
    if (!note || typeof note !== 'object' || Array.isArray(note) ||
      !Object.keys(note).every(key => ['id', 'title', 'legacy_entry_id'].includes(key)) ||
      Object.keys(note).length !== (note.legacy_entry_id === undefined ? 2 : 3) ||
      !NOTE_ID.test(note.id) || seen.has(note.id) ||
      (note.legacy_entry_id !== undefined && !NOTE_ID.test(note.legacy_entry_id)) ||
      typeof note.title !== 'string' || [...note.title].length < 1 ||
      [...note.title].length > 80 || note.title.includes('\0')) {
      throw new VaultError(502, 'private_notebook_invalid');
    }
    seen.add(note.id);
  }
  const imported = record.notes.filter((note: PrivateNote) => note.legacy_entry_id !== undefined)
    .map((note: PrivateNote) => note.legacy_entry_id);
  if (new Set(imported).size !== imported.length) throw new VaultError(502, 'private_notebook_invalid');
  const pending = record.pending_deletes ?? [];
  if (!Array.isArray(pending) || pending.length > MAX_PENDING_DELETES) throw new VaultError(502, 'private_notebook_invalid');
  for (const item of pending) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
      Object.keys(item).length !== 2 || !NOTE_ID.test(item.id) || !REVISION.test(item.revision) ||
      seen.has(item.id)) throw new VaultError(502, 'private_notebook_invalid');
    seen.add(item.id);
  }
  return { notes: record.notes as PrivateNote[], pendingDeletes: pending, revision };
}

export async function listPrivateNotes(workspaceId: string, passphrase: string, signal?: AbortSignal): Promise<PrivateNotebook> {
  const id = await privateNotebookID(workspaceId);
  try {
    const { plaintext, revision } = await readVaultObject(id, passphrase, signal);
    return parseNotebook(plaintext, workspaceId, revision);
  } catch (error) {
    if (error instanceof VaultError && error.status === 404) return { notes: [], pendingDeletes: [] };
    throw error;
  }
}

function notebookPayload(workspaceId: string, notebook: PrivateNotebook): string {
  return JSON.stringify({
    version: 1, workspace_id: workspaceId, notes: notebook.notes,
    ...(notebook.pendingDeletes.length ? { pending_deletes: notebook.pendingDeletes } : {}),
  });
}

function notePayload(workspaceId: string, body: string): string {
  validWorkspace(workspaceId);
  if (encoder.encode(body).length > MAX_BODY_BYTES) throw new VaultError(413, 'private_note_too_large');
  return JSON.stringify({ version: 1, workspace_id: workspaceId, body });
}

export async function readPrivateNote(workspaceId: string, id: string, passphrase: string, signal?: AbortSignal) {
  validWorkspace(workspaceId);
  if (!NOTE_ID.test(id)) throw new VaultError(400, 'private_note_invalid');
  const { plaintext, revision } = await readVaultObject(id, passphrase, signal);
  let value: unknown;
  try { value = JSON.parse(plaintext); } catch { throw new VaultError(502, 'private_note_invalid'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new VaultError(502, 'private_note_invalid');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== 3 || record.version !== 1 || record.workspace_id !== workspaceId ||
    typeof record.body !== 'string' || encoder.encode(record.body).length > MAX_BODY_BYTES) {
    throw new VaultError(502, 'private_note_invalid');
  }
  return { body: record.body, revision };
}

export async function createPrivateNote(workspaceId: string, passphrase: string, title: string,
  body: string, notebook: PrivateNotebook, signal?: AbortSignal, legacyEntryId?: string) {
  const trimmed = title.trim();
  if (!trimmed || [...trimmed].length > 80 || trimmed.includes('\0') ||
    notebook.notes.length >= MAX_NOTES || notebook.revision !== undefined && !REVISION.test(notebook.revision) ||
    (legacyEntryId !== undefined && !NOTE_ID.test(legacyEntryId))) {
    throw new VaultError(400, 'private_note_invalid');
  }
  if (legacyEntryId && notebook.notes.some(note => note.legacy_entry_id === legacyEntryId)) {
    throw new VaultError(409, 'private_import_exists');
  }
  const id = [...crypto.getRandomValues(new Uint8Array(16))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  const payload = notePayload(workspaceId, body);
  const contentRevision = await writeVaultObject(id, passphrase, payload, undefined, signal);
  const indexID = await privateNotebookID(workspaceId);
  let current = notebook;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (legacyEntryId && current.notes.some(note => note.legacy_entry_id === legacyEntryId)) {
      throw new VaultError(409, 'private_import_exists');
    }
    const nextNotes = [...current.notes, {
      id, title: trimmed, ...(legacyEntryId ? { legacy_entry_id: legacyEntryId } : {}),
    }];
    const manifest = notebookPayload(workspaceId, { ...current, notes: nextNotes });
    try {
      const revision = await writeVaultObject(indexID, passphrase, manifest, current.revision, signal);
      return { notebook: { ...current, notes: nextNotes, revision }, id, contentRevision };
    } catch (error) {
      if (signal?.aborted) throw error;
      // A lost response can follow a committed index write. Only a confirmed
      // conflict with a readable index permits one CAS merge.
      let remote: PrivateNotebook;
      try { remote = await listPrivateNotes(workspaceId, passphrase, signal); }
      catch { throw error; }
      if (remote.notes.some(note => note.id === id && note.title === trimmed)) {
        return { notebook: remote, id, contentRevision };
      }
      if (!(error instanceof VaultError && error.status === 409) || attempt > 0 ||
        remote.notes.length >= MAX_NOTES || remote.notes.some(note => note.id === id)) {
        throw error;
      }
      current = remote;
    }
  }
  throw new VaultError(409, 'private_notebook_conflict');
}

export async function updatePrivateNote(workspaceId: string, id: string, passphrase: string,
  body: string, revision: string, signal?: AbortSignal): Promise<string> {
  if (!NOTE_ID.test(id) || !REVISION.test(revision)) throw new VaultError(400, 'private_note_invalid');
  return writeVaultObject(id, passphrase, notePayload(workspaceId, body), revision, signal);
}

export async function renamePrivateNote(workspaceId: string, id: string, passphrase: string,
  title: string, notebook: PrivateNotebook, signal?: AbortSignal): Promise<PrivateNotebook> {
  validWorkspace(workspaceId);
  const trimmed = title.trim();
  if (!NOTE_ID.test(id) || !trimmed || [...trimmed].length > 80 || trimmed.includes('\0') ||
    !notebook.revision || !REVISION.test(notebook.revision) ||
    !notebook.notes.some(note => note.id === id)) {
    throw new VaultError(400, 'private_note_invalid');
  }
  const notes = notebook.notes.map(note => note.id === id ? { ...note, title: trimmed } : note);
  const manifest = notebookPayload(workspaceId, { ...notebook, notes });
  const revision = await writeVaultObject(await privateNotebookID(workspaceId), passphrase,
    manifest, notebook.revision, signal);
  return { ...notebook, notes, revision };
}

export async function retryPrivateNoteCleanup(workspaceId: string, passphrase: string,
  notebook: PrivateNotebook, signal?: AbortSignal): Promise<PrivateNotebook> {
  let current = notebook;
  for (const item of notebook.pendingDeletes.slice(0, 20)) {
    if (!current.pendingDeletes.some(entry => entry.id === item.id && entry.revision === item.revision)) continue;
    try {
      await deleteVaultObject(item.id, item.revision, signal);
    } catch (error) {
      if (!(error instanceof VaultError && error.status === 404)) break;
    }
    // Keep the tombstone until the object is gone; a failed index CAS leaves
    // durable work for the next device or unlock attempt.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (!current.pendingDeletes.some(entry => entry.id === item.id && entry.revision === item.revision)) break;
      const next = { ...current, pendingDeletes: current.pendingDeletes.filter(entry => entry.id !== item.id) };
      try {
        const revision = await writeVaultObject(await privateNotebookID(workspaceId), passphrase,
          notebookPayload(workspaceId, next), current.revision, signal);
        current = { ...next, revision };
        break;
      } catch (error) {
        if (!(error instanceof VaultError && error.status === 409) || signal?.aborted) return current;
        try { current = await listPrivateNotes(workspaceId, passphrase, signal); }
        catch { return current; }
      }
    }
  }
  return current;
}

export async function deletePrivateNote(workspaceId: string, id: string, passphrase: string,
  notebook: PrivateNotebook, contentRevision: string, signal?: AbortSignal): Promise<PrivateNotebook> {
  validWorkspace(workspaceId);
  if (!NOTE_ID.test(id) || !REVISION.test(contentRevision) || !notebook.revision ||
    !REVISION.test(notebook.revision) || !notebook.notes.some(note => note.id === id) ||
    notebook.pendingDeletes.length >= MAX_PENDING_DELETES) {
    throw new VaultError(400, 'private_note_invalid');
  }
  const next = {
    ...notebook,
    notes: notebook.notes.filter(note => note.id !== id),
    pendingDeletes: [...notebook.pendingDeletes, { id, revision: contentRevision }],
  };
  const revision = await writeVaultObject(await privateNotebookID(workspaceId), passphrase,
    notebookPayload(workspaceId, next), notebook.revision, signal);
  return retryPrivateNoteCleanup(workspaceId, passphrase, { ...next, revision }, signal);
}

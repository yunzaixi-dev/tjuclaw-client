import { getEntry } from './library';
import { createPrivateNote, listPrivateNotes, readPrivateNote, type PrivateNotebook } from './private-notes';
import { VaultError } from './sealed-vault';

const ID = /^[0-9a-f]{32}$/;

// The source stays in the legacy store. Only the sealed destination and index
// may be written; a failed readback must never be presented as a completed copy.
export async function copyLegacyMarkdownNote(workspaceId: string, entryId: string,
  passphrase: string, notebook: PrivateNotebook, signal?: AbortSignal) {
  if (!ID.test(workspaceId) || !ID.test(entryId) || notebook.notes.some(note => note.legacy_entry_id === entryId)) {
    throw new VaultError(409, 'private_import_exists');
  }
  const source = await getEntry(entryId, signal);
  if (source.library_id !== workspaceId || source.id !== entryId || source.kind !== 'note' ||
    (source.body !== undefined && typeof source.body !== 'string') || !source.title.trim()) {
    throw new VaultError(400, 'private_import_source_invalid');
  }
  const body = source.body ?? '';
  const result = await createPrivateNote(workspaceId, passphrase, source.title,
    body, notebook, signal, entryId);
  let confirmed: Awaited<ReturnType<typeof readPrivateNote>>;
  let index: PrivateNotebook;
  try {
    confirmed = await readPrivateNote(workspaceId, result.id, passphrase, signal);
    index = await listPrivateNotes(workspaceId, passphrase, signal);
  } catch {
    throw new VaultError(502, 'private_import_unverified');
  }
  if (confirmed.body !== body ||
    !index.notes.some(note => note.id === result.id && note.title === source.title.trim() &&
      note.legacy_entry_id === entryId)) {
    throw new VaultError(502, 'private_import_unverified');
  }
  return { ...result, notebook: index, body: confirmed.body, contentRevision: confirmed.revision };
}

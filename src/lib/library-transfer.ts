import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { AuthError } from './auth';
import { createEntry, createFolder, getEntry, listEntries, listFolders, uploadFile, type Entry, type Library } from './library';

// Moving a whole library in and out as ordinary files: a ZIP of folders,
// Markdown notes and the uploaded originals, or Markdown files and ZIPs
// brought back in. Everything runs in the browser with the user's session.

const MAX_FILE = 8 * 1024 * 1024;
const MAX_IMPORT = 400;

export type TransferProgress = (done: number, total: number) => void;

/** A name safe as one path component on every desktop system. */
function segment(name: string) {
  const visible = [...name].map(char => char.charCodeAt(0) < 32 ? '_' : char).join('');
  const cleaned = visible.replace(/[\\/:*?"<>|]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 80);
  return cleaned || '未命名';
}

function unique(path: string, taken: Set<string>) {
  const dot = path.lastIndexOf('.');
  const [stem, ext] = dot > path.lastIndexOf('/') ? [path.slice(0, dot), path.slice(dot)] : [path, ''];
  let candidate = path;
  for (let n = 2; taken.has(candidate.toLocaleLowerCase()); n++) candidate = `${stem} (${n})${ext}`;
  taken.add(candidate.toLocaleLowerCase());
  return candidate;
}

type RichNode = { type?: string; text?: string; attrs?: { level?: number }; content?: RichNode[] };

/** Rich text (the editor's JSON) as readable Markdown: headings, lists, paragraphs. */
export function richTextToMarkdown(body: string) {
  let doc: RichNode;
  try { doc = JSON.parse(body) as RichNode; } catch { return body; }
  const text = (node: RichNode): string => node.text ?? (node.content ?? []).map(text).join('');
  const block = (node: RichNode, depth = 0): string => {
    switch (node.type) {
      case 'heading': return `${'#'.repeat(Math.min(6, node.attrs?.level ?? 1))} ${text(node)}`;
      case 'bulletList': return (node.content ?? []).map(item => `${'  '.repeat(depth)}- ${(item.content ?? []).map(child => block(child, depth + 1)).join('\n').trimStart()}`).join('\n');
      case 'orderedList': return (node.content ?? []).map((item, index) => `${'  '.repeat(depth)}${index + 1}. ${(item.content ?? []).map(child => block(child, depth + 1)).join('\n').trimStart()}`).join('\n');
      case 'blockquote': return (node.content ?? []).map(child => `> ${block(child, depth)}`).join('\n');
      case 'codeBlock': return `\`\`\`\n${text(node)}\n\`\`\``;
      case 'horizontalRule': return '---';
      default: return node.content?.some(child => child.content) ? (node.content ?? []).map(child => block(child, depth)).join('\n\n') : text(node);
    }
  };
  return block(doc).trim() + '\n';
}

async function fileBytes(id: string, signal?: AbortSignal) {
  const response = await fetch(`/api/entries/${id}/file`, { signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
  if (!response.ok) throw new AuthError(response.status);
  return new Uint8Array(await response.arrayBuffer());
}

/** Builds the library as a ZIP and saves it. Resolves to how many items it holds. */
export async function exportLibrary(library: Library, onProgress?: TransferProgress, signal?: AbortSignal) {
  const [entries, folders] = await Promise.all([listEntries(library.id, signal), listFolders(library.id, signal)]);
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const folderPath = (id: string, seen = new Set<string>()): string => {
    const folder = byId.get(id);
    if (!folder || seen.has(id)) return '';
    seen.add(id);
    const parent = folder.parent_id ? folderPath(folder.parent_id, seen) : '';
    return `${parent}${segment(folder.title)}/`;
  };
  const items = entries.filter(entry => entry.kind === 'note' || entry.kind === 'rich_text' || entry.kind === 'file');
  const files: Record<string, Uint8Array> = {};
  const taken = new Set<string>();
  for (const folder of folders) files[folderPath(folder.id)] = new Uint8Array();
  let done = 0;
  for (const item of items) {
    const directory = item.parent_id && byId.has(item.parent_id) ? folderPath(item.parent_id) : '';
    if (item.kind === 'file') {
      files[unique(`${directory}${segment(item.title)}`, taken)] = await fileBytes(item.id, signal);
    } else {
      const full: Entry = item.body === undefined ? await getEntry(item.id, signal) : item;
      const markdown = item.kind === 'rich_text' ? richTextToMarkdown(full.body ?? '') : full.body ?? '';
      files[unique(`${directory}${segment(item.title || '未命名笔记')}.md`, taken)] = strToU8(markdown);
    }
    onProgress?.(++done, items.length);
  }
  const zipped = zipSync(files, { level: 6 });
  const href = URL.createObjectURL(new Blob([zipped as BlobPart], { type: 'application/zip' }));
  const link = document.createElement('a');
  link.href = href;
  link.download = `${segment(library.name)}.zip`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(href), 1000);
  return items.length;
}

type Incoming = { path: string[]; name: string; data: Uint8Array };

function textFile(name: string) { return /\.(md|markdown|txt)$/i.test(name); }

/** The files a selection holds: ZIPs are opened, hidden and system files skipped. */
async function expand(selection: File[]): Promise<Incoming[]> {
  const out: Incoming[] = [];
  for (const file of selection) {
    const data = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name)) {
      const unzipped = unzipSync(data);
      for (const [path, bytes] of Object.entries(unzipped)) {
        const parts = path.split('/').filter(Boolean);
        if (!parts.length || path.endsWith('/') || parts.some(part => part.startsWith('.') || part === '__MACOSX')) continue;
        out.push({ path: parts.slice(0, -1), name: parts[parts.length - 1], data: bytes });
      }
    } else {
      out.push({ path: [], name: file.name, data });
    }
  }
  return out;
}

export type ImportResult = { notes: number; files: number; folders: number; skipped: number };

/**
 * Brings Markdown and text files in as notes and other files as attachments,
 * recreating a ZIP's folders under parentId. Files over 8 MB are skipped.
 */
export async function importIntoLibrary(libraryId: string, selection: File[], parentId?: string, onProgress?: TransferProgress, signal?: AbortSignal): Promise<ImportResult> {
  const incoming = (await expand(selection)).slice(0, MAX_IMPORT);
  const result: ImportResult = { notes: 0, files: 0, folders: 0, skipped: 0 };
  const folderIds = new Map<string, string>();
  const ensureFolder = async (path: string[]) => {
    let parent = parentId ?? '';
    for (let depth = 0; depth < path.length; depth++) {
      const key = path.slice(0, depth + 1).join('/');
      let id = folderIds.get(key);
      if (!id) {
        id = (await createFolder(libraryId, path[depth].slice(0, 80), parent || undefined, signal)).id;
        folderIds.set(key, id);
        result.folders++;
      }
      parent = id;
    }
    return parent;
  };
  let done = 0;
  for (const item of incoming) {
    const parent = await ensureFolder(item.path);
    if (item.data.length > MAX_FILE || item.data.length === 0) {
      result.skipped++;
    } else if (textFile(item.name)) {
      const title = item.name.replace(/\.(md|markdown|txt)$/i, '').slice(0, 120) || '未命名笔记';
      await createEntry(libraryId, { kind: 'note', title, body: strFromU8(item.data), ...(parent ? { parent_id: parent } : {}) }, signal);
      result.notes++;
    } else {
      await uploadFile(libraryId, new File([item.data as BlobPart], item.name), parent || undefined, signal);
      result.files++;
    }
    onProgress?.(++done, incoming.length);
  }
  return result;
}

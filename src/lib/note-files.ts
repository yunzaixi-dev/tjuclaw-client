import type { Entry } from './library';

// The open library only. Resolve explicit paths before unique short names;
// never silently open a different note/image when names are ambiguous.

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

type IndexedEntry = { path: string; name: string; id: string; kind: Entry['kind'] };
let files: IndexedEntry[] = [];
let indexedEntries: Entry[] | undefined;
let revision = 0;
export const noteFilesRevision = () => revision;
const key = (value: string) => value.normalize('NFC').toLowerCase();

/** Records the library's files; call when its entries change. */
export function setNoteFiles(entries: Entry[]) {
  if (indexedEntries === entries) return;
  indexedEntries = entries;
  revision++;
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const pathOf = (entry: Entry) => {
    const parts = [entry.title];
    const seen = new Set<string>();
    for (let parent = byId.get(entry.parent_id ?? ''); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id ?? '')) {
      seen.add(parent.id);
      parts.unshift(parent.title);
    }
    return key(parts.join('/'));
  };
  files = entries.map(entry => ({ path: pathOf(entry), name: key(entry.title), id: entry.id, kind: entry.kind }));
}

function decode(value: string) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function targetParts(target: string) {
  const raw = target.split('|')[0].trim();
  const hash = raw.indexOf('#');
  return {
    path: decode(hash < 0 ? raw : raw.slice(0, hash)).replace(/\\/g, '/'),
    fragment: hash < 0 ? '' : decode(raw.slice(hash + 1)),
  };
}

function safePath(path: string, base = ''): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//') || [...path].some(char => char.charCodeAt(0) < 32)) return null;
  const parts = base ? base.split('/') : [];
  for (const part of path.replace(/^\//, '').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) return null; parts.pop(); }
    else parts.push(part);
  }
  return key(parts.join('/'));
}

function unique(items: IndexedEntry[]) {
  return items.length === 1 ? items[0] : null;
}

function resolve(target: string, sourceId: string | undefined, kinds: Entry['kind'][], wiki = false) {
  const { path } = targetParts(target);
  const source = files.find(file => file.id === sourceId);
  const base = source?.path.split('/').slice(0, -1).join('/') ?? '';
  const eligible = files.filter(file => kinds.includes(file.kind));
  const note = kinds.includes('note');
  const canonical = (value: string) => note ? value.replace(/\.(md|markdown)$/i, '') : value;
  const exact = (value: string | null) => value === null ? null : unique(eligible.filter(file => canonical(file.path) === canonical(value)));
  const relative = safePath(path, base);
  const root = safePath(path);
  // ./ and ../ are always relative; never fall back to a same-named file.
  if (/^\.\.?\//.test(path)) return exact(relative);
  if (!path || root === null) return null;
  const match = wiki ? exact(root) ?? exact(relative) : exact(relative) ?? exact(root);
  if (match) return match;
  // A written directory must match. Only short names get a vault-wide fallback.
  if (path.includes('/')) return wiki && !path.startsWith('/')
    ? unique(eligible.filter(file => canonical(file.path).endsWith(`/${canonical(root)}`))) : null;
  return unique(eligible.filter(file => canonical(file.name) === canonical(root)));
}

/** The address of the library file a note refers to, or null. */
export function resolveNoteFile(target: string, sourceId?: string, wiki = false): string | null {
  const match = resolve(target, sourceId, ['file'], wiki);
  return match ? `/api/entries/${match.id}/file` : null;
}

export function resolveNoteLink(target: string, sourceId?: string, wiki = false): { id: string; fragment: string } | null {
  const { path, fragment } = targetParts(target);
  if (!path && fragment && files.some(file => file.id === sourceId && file.kind === 'note')) return { id: sourceId!, fragment };
  const match = resolve(target, sourceId, ['note', 'rich_text'], wiki);
  return match ? { id: match.id, fragment } : null;
}

export const isImageTarget = (target: string) => IMAGE.test(targetParts(target).path);

/** The width an Obsidian embed asks for: ![[x.png|300]]. */
export function embedWidth(target: string) {
  const size = /\|\s*(\d{1,4})(?:x\d{1,4})?\s*$/.exec(target);
  return size ? Number(size[1]) : undefined;
}

/**
 * Rewrites Obsidian embeds outside code into Markdown the renderer knows:
 * images become images of the library file, other files become links.
 */
export function expandEmbeds(markdown: string, sourceId?: string) {
  if (!markdown.includes('![[')) return markdown;
  let inFence = false;
  return markdown.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.split(/(`[^`]*`)/).map(part => part.startsWith('`') ? part : part.replace(/!\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
      const url = resolveNoteFile(target, sourceId, true);
      const label = (target.split('|')[0].split('/').pop() ?? '').replace(/[[\]]/g, '');
      if (!url) return whole;
      if (!isImageTarget(target)) return `[${label}](${url})`;
      const width = embedWidth(target);
      return width ? `<img src="${url}" alt="${label.replace(/"/g, '&quot;')}" width="${width}">` : `![${label}](${url})`;
    })).join('');
  }).join('\n');
}

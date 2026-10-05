import type { Entry } from './library';

// Files of the open library, by path, so notes can show their images the way
// Obsidian does: ![[name.png]], ![[folder/name.png|300]] or a relative
// ![](assets/name.png). A target resolves to the file whose path ends with it,
// else to a file of that name; the shortest path wins a tie.

const IMAGE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i;

let files: { path: string; name: string; id: string }[] = [];

/** Records the library's files; call when its entries change. */
export function setNoteFiles(entries: Entry[]) {
  const byId = new Map(entries.map(entry => [entry.id, entry]));
  const pathOf = (entry: Entry) => {
    const parts = [entry.title];
    const seen = new Set<string>();
    for (let parent = byId.get(entry.parent_id ?? ''); parent && !seen.has(parent.id); parent = byId.get(parent.parent_id ?? '')) {
      seen.add(parent.id);
      parts.unshift(parent.title);
    }
    return parts.join('/').toLowerCase();
  };
  files = entries.filter(entry => entry.kind === 'file')
    .map(entry => ({ path: pathOf(entry), name: entry.title.toLowerCase(), id: entry.id }))
    .sort((a, b) => a.path.length - b.path.length);
}

function normalize(target: string) {
  let value = target.split('|')[0].split('#')[0].trim().replace(/\\/g, '/');
  try { value = decodeURIComponent(value); } catch { /* keep as written */ }
  return value.split('/').filter(part => part && part !== '.' && part !== '..').join('/').toLowerCase();
}

/** The address of the library file a note refers to, or null. */
export function resolveNoteFile(target: string): string | null {
  if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('/') || target.startsWith('#')) return null;
  const wanted = normalize(target);
  if (!wanted) return null;
  const name = wanted.split('/').pop() ?? '';
  const match = files.find(file => file.path === wanted || file.path.endsWith(`/${wanted}`))
    ?? files.find(file => file.name === name);
  return match ? `/api/entries/${match.id}/file` : null;
}

export const isImageTarget = (target: string) => IMAGE.test(normalize(target));

/** The width an Obsidian embed asks for: ![[x.png|300]]. */
export function embedWidth(target: string) {
  const size = /\|\s*(\d{1,4})(?:x\d{1,4})?\s*$/.exec(target);
  return size ? Number(size[1]) : undefined;
}

/**
 * Rewrites Obsidian embeds outside code into Markdown the renderer knows:
 * images become images of the library file, other files become links.
 */
export function expandEmbeds(markdown: string) {
  if (!markdown.includes('![[')) return markdown;
  let inFence = false;
  return markdown.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; return line; }
    if (inFence) return line;
    return line.split(/(`[^`]*`)/).map(part => part.startsWith('`') ? part : part.replace(/!\[\[([^\]\n]+)\]\]/g, (whole, target: string) => {
      const url = resolveNoteFile(target);
      const label = (target.split('|')[0].split('/').pop() ?? '').replace(/[[\]]/g, '');
      if (!url) return whole;
      if (!isImageTarget(target)) return `[${label}](${url})`;
      const width = embedWidth(target);
      return width ? `<img src="${url}" alt="${label.replace(/"/g, '&quot;')}" width="${width}">` : `![${label}](${url})`;
    })).join('');
  }).join('\n');
}

// What a new version changes, in a few short lines, for the update notices.
// The web notice lists the public changelog's entries it has not shown yet;
// a desktop release puts the lines of public/release-notes.json into its
// updater manifest.

export const MAX_NOTE_ITEMS = 4;
const MAX_NOTE_LENGTH = 80;

/** Keeps up to four non-empty single lines, each cut to a readable length. */
export function summaryLines(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const lines: string[] = [];
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const line = value.replace(/\s+/g, ' ').trim();
    if (!line) continue;
    lines.push(line.length > MAX_NOTE_LENGTH ? `${line.slice(0, MAX_NOTE_LENGTH - 1)}…` : line);
    if (lines.length === MAX_NOTE_ITEMS) break;
  }
  return lines;
}

/**
 * The summary in an updater manifest's notes: one change per line. A manifest
 * written before summaries existed only names the version and its commit,
 * which is not a change and is left out.
 */
export function summaryFromNotes(notes: string | undefined): string[] {
  return summaryLines((notes ?? '').split('\n').filter(line => !/^TJUClaw Client v\d/.test(line.trim())));
}

type ChangelogItem = { title: string; at: number };

const SEEN_KEY = 'tjuclaw.release-notes.seen';

function readSeen(): number {
  try {
    const value = Number(localStorage.getItem(SEEN_KEY));
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/**
 * Remembers the newest entry the notice has shown, so the next update lists
 * only what came after it.
 */
export function markReleaseNotesSeen(at: number) {
  if (!(at > readSeen())) return;
  try { localStorage.setItem(SEEN_KEY, String(at)); } catch { /* Only this notice repeats. */ }
}

/**
 * The web notice's summary: titles of the public changelog entries this
 * device has not been shown yet, newest first. Web deployments share one
 * version number, so a fixed list shipped with the build repeated itself;
 * the changelog says what each change was. Before any notice, entries
 * published after the running build count as new. Resolves to no lines when
 * the list cannot be read.
 */
export async function fetchReleaseSummary(builtAt: string, signal?: AbortSignal): Promise<{ lines: string[]; newest: number }> {
  try {
    const response = await fetch('/api/release-notes', { cache: 'no-store', credentials: 'omit', signal });
    if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('json')) return { lines: [], newest: 0 };
    const data: unknown = await response.json();
    const raw = data && typeof data === 'object' ? (data as { items?: unknown }).items : null;
    if (!Array.isArray(raw)) return { lines: [], newest: 0 };
    const since = Math.max(readSeen(), Date.parse(builtAt) || 0);
    const items: ChangelogItem[] = [];
    for (const value of raw) {
      if (!value || typeof value !== 'object') continue;
      const { title, published_at: published } = value as { title?: unknown; published_at?: unknown };
      const at = typeof published === 'string' ? Date.parse(published) : NaN;
      if (typeof title === 'string' && Number.isFinite(at) && at > since) items.push({ title, at });
    }
    items.sort((a, b) => b.at - a.at);
    return { lines: summaryLines(items.map(item => item.title)), newest: items[0]?.at ?? 0 };
  } catch {
    return { lines: [], newest: 0 };
  }
}

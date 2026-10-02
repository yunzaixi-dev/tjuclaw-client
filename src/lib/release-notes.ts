// What a new version changes, in a few short lines, for the update notices.
// The lines live in public/release-notes.json, which ships with every build:
// the web notice reads the newly deployed copy, and the desktop release puts
// the same lines into the updater manifest.

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

/**
 * Reads the summary of the build now deployed. Resolves to no lines when the
 * file is missing (the server answers a missing file with the app's page) or
 * cannot be read: the notice then simply has no summary.
 */
export async function fetchReleaseSummary(signal?: AbortSignal): Promise<string[]> {
  try {
    const response = await fetch(`/release-notes.json?t=${Date.now()}`, { cache: 'no-store', credentials: 'omit', signal });
    if (!response.ok || !(response.headers.get('Content-Type') ?? '').includes('json')) return [];
    const data: unknown = await response.json();
    return summaryLines(data && typeof data === 'object' ? (data as { items?: unknown }).items : null);
  } catch {
    return [];
  }
}

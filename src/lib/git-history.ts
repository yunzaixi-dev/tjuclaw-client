import { authRequest, AuthError } from './auth';

// Each library is mirrored into the owner's Git repository; these read the
// sync state and one note's commits.

export interface GitStatus {
  enabled: boolean;
  state?: 'pending' | 'syncing' | 'synced' | 'error';
  revision?: string;
  notes?: number;
  synced_at?: string;
}

export interface NoteCommit {
  sha: string;
  message: string;
  author: string;
  date: string;
}

const isSha = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);

export async function getGitStatus(signal?: AbortSignal): Promise<GitStatus> {
  const data = await authRequest<{ git: unknown }>('/api/library/git', { signal });
  const git = data?.git as Record<string, unknown> | undefined;
  if (!git || typeof git.enabled !== 'boolean') throw new AuthError(503);
  return {
    enabled: git.enabled,
    state: ['pending', 'syncing', 'synced', 'error'].includes(git.state as string) ? git.state as GitStatus['state'] : undefined,
    revision: isSha(git.revision) ? git.revision : undefined,
    notes: typeof git.notes === 'number' ? git.notes : undefined,
    synced_at: typeof git.synced_at === 'string' ? git.synced_at : undefined,
  };
}

export async function getNoteHistory(entryId: string, signal?: AbortSignal): Promise<{ path: string; commits: NoteCommit[] }> {
  const data = await authRequest<{ path: unknown; commits: unknown }>(`/api/entries/${entryId}/history`, { signal });
  if (typeof data?.path !== 'string' || !Array.isArray(data.commits)) throw new AuthError(503);
  const commits = data.commits.filter((item): item is NoteCommit => Boolean(item) && typeof item === 'object'
    && isSha((item as NoteCommit).sha) && typeof (item as NoteCommit).message === 'string'
    && typeof (item as NoteCommit).date === 'string');
  return { path: data.path, commits };
}

export async function getNoteRevision(entryId: string, revision: string, signal?: AbortSignal): Promise<string> {
  if (!isSha(revision)) throw new AuthError(400);
  const data = await authRequest<{ content: unknown }>(`/api/entries/${entryId}/history?revision=${revision}`, { signal });
  if (typeof data?.content !== 'string') throw new AuthError(503);
  return data.content;
}

export function gitStatusLabel(status: GitStatus | null): string {
  if (!status?.enabled) return '';
  switch (status.state) {
    case 'synced': return `Git 已同步${status.revision ? ` · ${status.revision.slice(0, 7)}` : ''}`;
    case 'syncing': case 'pending': return 'Git 同步中…';
    case 'error': return 'Git 同步失败，稍后重试';
    default: return '';
  }
}

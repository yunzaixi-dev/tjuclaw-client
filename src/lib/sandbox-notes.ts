import { authRequest } from './auth';

type Access = { token: string; gateway_url?: string; expires_at: string };
type Identity = { version: 'session.v1'; owner_id: string; session_id: string; entry_id: string; profile: string };
export type SandboxSearchHit = { path: string; snippet: string; score: number };
export type SandboxNoteGraph = { nodes: string[]; edges: { source: string; target: string }[]; revision: string };
const HEX32 = /^[0-9a-f]{32}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const MAX_NOTE_BYTES = 80 << 10;

export class SandboxNoteConflict extends Error {
  constructor() {
    super('远端文件已更新，当前草稿未覆盖。请先复制草稿，再刷新文件核对。');
    this.name = 'SandboxNoteConflict';
  }
}

class SandboxNoteRequestError extends Error {
  constructor(public status: number) {
    super(status === 404 ? '笔记不存在或已被其他设备删除，请刷新文件列表。' : `沙箱读取失败（${status}），请稍后重试。`);
  }
}

function notePath(path: string): boolean {
  return path.length > 0 && path.length <= 512 && path.toLowerCase().endsWith('.md')
    && !/[\\:\r\n\0]/.test(path) && path.split('/').every(part => part.length > 0 && !part.startsWith('.'));
}

async function requestWorkspace<T>(
  sessionId: string, ownerId: string, entryId: string, preset: string,
  route: 'notes' | 'note' | 'note/move' | 'search' | 'graph', path: string | undefined, signal?: AbortSignal,
  update?: { expected_revision: string; content: string; create?: boolean },
  query?: string,
  remove?: { expected_revision: string },
  move?: { expected_revision: string; destination: string },
): Promise<T> {
  if (update && new TextEncoder().encode(update.content).length > MAX_NOTE_BYTES) {
    throw new Error('笔记超过 80 KiB，当前沙箱无法保存；草稿已保留。');
  }
  if (!HEX32.test(sessionId) || !HEX32.test(entryId) || (path !== undefined && !notePath(path)) ||
    (route === 'search' && (!query?.trim() || new TextEncoder().encode(query).length > 128)) ||
    (remove && (route !== 'note' || path === undefined || update !== undefined || !HEX40.test(remove.expected_revision))) ||
    (move && (route !== 'note/move' || path === undefined || update !== undefined || remove !== undefined ||
      !HEX40.test(move.expected_revision) || !notePath(move.destination) || move.destination === path)) ||
    (update && (path === undefined || !HEX40.test(update.expected_revision)))) {
    throw new Error('无效的工作区文件路径。');
  }
  const grant = await authRequest<Access>(`/api/sessions/${sessionId}/sandbox-token`, { method: 'POST', signal });
  if (!grant?.token || !grant.gateway_url || !Number.isFinite(Date.parse(grant.expires_at)) || Date.parse(grant.expires_at) <= Date.now()) {
    throw new Error('沙箱直连入口尚未配置。');
  }
  const url = new URL(grant.gateway_url);
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('沙箱入口地址无效。');
  }
  const identity: Identity = {
    version: 'session.v1', owner_id: ownerId, session_id: sessionId,
    entry_id: entryId, profile: preset === 'guide' ? 'study-guide' : 'study-agent',
  };
  const response = await fetch(new URL(`/v1/sessions/${route}`, url), {
    method: remove ? 'DELETE' : update ? (update.create ? 'PUT' : 'PATCH') : 'POST',
    mode: 'cors', credentials: 'omit', cache: 'no-store',
    redirect: 'error', referrerPolicy: 'no-referrer', signal,
    headers: { Authorization: `Bearer ${grant.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(path === undefined ? { ...identity, ...(query === undefined ? {} : { query }) } : {
      ...identity, path, ...(update ? { expected_revision: update.expected_revision, content: update.content } : {}),
      ...(remove ? { expected_revision: remove.expected_revision } : {}),
      ...(move ? { expected_revision: move.expected_revision, destination: move.destination } : {}),
    }),
  });
  if (response.status === 409 && update) throw new SandboxNoteConflict();
  if (response.status === 409 && remove) throw new Error('远端文件已更新，未删除笔记。请刷新后重试。');
  if (response.status === 409 && move) throw new Error('路径已存在或远端版本已更新，未移动笔记。请刷新后重试。');
  if (!response.ok) throw new SandboxNoteRequestError(response.status);
  return await response.json() as T;
}

export async function searchSandboxNotes(sessionId: string, ownerId: string, entryId: string, preset: string,
  query: string, signal?: AbortSignal): Promise<{ hits: SandboxSearchHit[]; revision: string }> {
  const data = await requestWorkspace<{ version: string; hits: unknown; revision: unknown }>(
    sessionId, ownerId, entryId, preset, 'search', undefined, signal, undefined, query);
  if (data.version !== 'session.v1' || !Array.isArray(data.hits) || data.hits.length > 20 ||
    !data.hits.every((item: unknown) => {
      if (!item || typeof item !== 'object') return false;
      const hit = item as Record<string, unknown>;
      return typeof hit.path === 'string' && notePath(hit.path) &&
        typeof hit.snippet === 'string' && [...hit.snippet].length <= 160 &&
        typeof hit.score === 'number' && Number.isInteger(hit.score) && hit.score > 0 && hit.score <= 300;
    }) || new Set(data.hits.map((hit: SandboxSearchHit) => hit.path)).size !== data.hits.length ||
    typeof data.revision !== 'string' || !HEX40.test(data.revision)) throw new Error('沙箱返回了无效的检索结果。');
  return { hits: data.hits as SandboxSearchHit[], revision: data.revision };
}

export async function graphSandboxNotes(sessionId: string, ownerId: string, entryId: string, preset: string,
  signal?: AbortSignal): Promise<SandboxNoteGraph> {
  const data = await requestWorkspace<{ version: string; nodes: unknown; edges: unknown; revision: unknown }>(
    sessionId, ownerId, entryId, preset, 'graph', undefined, signal);
  if (data.version !== 'session.v1' || !Array.isArray(data.nodes) || data.nodes.length > 200 ||
    !data.nodes.every((node: unknown) => typeof node === 'string' && notePath(node)) ||
    new Set(data.nodes).size !== data.nodes.length || !Array.isArray(data.edges) || data.edges.length > 512 ||
    typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
    throw new Error('沙箱返回了无效的图谱。');
  }
  const nodes = new Set(data.nodes as string[]);
  const edgeKeys = new Set<string>();
  for (const edge of data.edges) {
    if (!edge || typeof edge !== 'object') throw new Error('沙箱返回了无效的图谱。');
    const { source, target } = edge as Record<string, unknown>;
    if (typeof source !== 'string' || typeof target !== 'string' || source === target ||
      !nodes.has(source) || !nodes.has(target)) throw new Error('沙箱返回了无效的图谱。');
    edgeKeys.add(JSON.stringify([source, target]));
  }
  if (edgeKeys.size !== data.edges.length) throw new Error('沙箱返回了无效的图谱。');
  return { nodes: data.nodes as string[], edges: data.edges as SandboxNoteGraph['edges'], revision: data.revision };
}

export async function listSandboxNotes(sessionId: string, ownerId: string, entryId: string, preset: string, signal?: AbortSignal): Promise<{ paths: string[]; revision: string }> {
  const data = await requestWorkspace<{ version: string; paths: unknown; revision: unknown }>(sessionId, ownerId, entryId, preset, 'notes', undefined, signal);
  if (data.version !== 'session.v1' || !Array.isArray(data.paths) || data.paths.length > 200 ||
    !data.paths.every(path => typeof path === 'string' && notePath(path)) ||
    typeof data.revision !== 'string' || !HEX40.test(data.revision)) throw new Error('沙箱返回了无效的文件列表。');
  return { paths: data.paths, revision: data.revision };
}

export async function readSandboxNote(sessionId: string, ownerId: string, entryId: string, preset: string, path: string, signal?: AbortSignal): Promise<{ content: string; revision: string }> {
  const data = await requestWorkspace<{ version: string; path: string; content: unknown; revision: unknown }>(sessionId, ownerId, entryId, preset, 'note', path, signal);
  if (data.version !== 'session.v1' || data.path !== path || typeof data.content !== 'string' ||
    new TextEncoder().encode(data.content).length > MAX_NOTE_BYTES ||
    typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
    throw new Error('沙箱返回了无效的文件内容。');
  }
  return { content: data.content, revision: data.revision };
}

export async function updateSandboxNote(sessionId: string, ownerId: string, entryId: string, preset: string,
  path: string, expected_revision: string, content: string, signal?: AbortSignal): Promise<string> {
  try {
    const data = await requestWorkspace<{ version: string; path: string; revision: unknown }>(
      sessionId, ownerId, entryId, preset, 'note', path, signal, { expected_revision, content });
    if (data.version !== 'session.v1' || data.path !== path || typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
      throw new Error('沙箱返回了无效的保存结果。');
    }
    return data.revision;
  } catch (error) {
    if (signal?.aborted || !(error instanceof SandboxNoteConflict ||
      error instanceof SandboxNoteRequestError && error.status >= 500 ||
      error instanceof TypeError)) throw error;
    try {
      const remote = await readSandboxNote(sessionId, ownerId, entryId, preset, path, signal);
      if (remote.revision !== expected_revision && remote.content === content) return remote.revision;
    } catch { /* Keep the original error if the read-back outcome is uncertain. */ }
    throw error;
  }
}

export async function createSandboxNote(sessionId: string, ownerId: string, entryId: string, preset: string,
  path: string, expected_revision: string, content: string, signal?: AbortSignal): Promise<string> {
  try {
    const data = await requestWorkspace<{ version: string; path: string; revision: unknown }>(
      sessionId, ownerId, entryId, preset, 'note', path, signal,
      { expected_revision, content, create: true });
    if (data.version !== 'session.v1' || data.path !== path || typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
      throw new Error('沙箱返回了无效的新建结果。');
    }
    return data.revision;
  } catch (error) {
    if (signal?.aborted || !(error instanceof SandboxNoteRequestError && error.status >= 500 ||
      error instanceof TypeError)) throw error;
    try {
      const remote = await readSandboxNote(sessionId, ownerId, entryId, preset, path, signal);
      if (remote.revision !== expected_revision && remote.content === content) return remote.revision;
    } catch { /* Preserve the original error when the remote outcome is uncertain. */ }
    throw new Error('新建结果未确认，可能已提交；请先刷新文件列表核对同名文件，不要直接重试。', { cause: error });
  }
}

export async function moveSandboxNote(sessionId: string, ownerId: string, entryId: string, preset: string,
  path: string, destination: string, expected_revision: string, content: string, signal?: AbortSignal): Promise<string> {
  try {
    const data = await requestWorkspace<{ version: string; path: string; destination: string; revision: unknown }>(
      sessionId, ownerId, entryId, preset, 'note/move', path, signal, undefined, undefined, undefined,
      { expected_revision, destination });
    if (data.version !== 'session.v1' || data.path !== path || data.destination !== destination ||
      typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
      throw new Error('沙箱返回了无效的移动结果。');
    }
    return data.revision;
  } catch (error) {
    if (signal?.aborted || !(error instanceof SandboxNoteRequestError && error.status >= 500 ||
      error instanceof TypeError)) throw error;
    try {
      const current = await listSandboxNotes(sessionId, ownerId, entryId, preset, signal);
      if (current.revision !== expected_revision && !current.paths.includes(path) && current.paths.includes(destination)) {
        const moved = await readSandboxNote(sessionId, ownerId, entryId, preset, destination, signal);
        if (moved.revision === current.revision && moved.content === content) return current.revision;
      }
    } catch { /* Leave the outcome uncertain when the read-back cannot confirm it. */ }
    throw new Error('移动结果未确认，可能已提交；请刷新文件列表核对，不要直接重试。', { cause: error });
  }
}

export async function deleteSandboxNote(sessionId: string, ownerId: string, entryId: string, preset: string,
  path: string, expected_revision: string, signal?: AbortSignal): Promise<string> {
  try {
    const data = await requestWorkspace<{ version: string; path: string; revision: unknown }>(
      sessionId, ownerId, entryId, preset, 'note', path, signal, undefined, undefined, { expected_revision });
    if (data.version !== 'session.v1' || data.path !== path || typeof data.revision !== 'string' || !HEX40.test(data.revision)) {
      throw new Error('沙箱返回了无效的删除结果。');
    }
    return data.revision;
  } catch (error) {
    if (signal?.aborted || !(error instanceof SandboxNoteRequestError && error.status >= 500 ||
      error instanceof TypeError)) throw error;
    try {
      const current = await listSandboxNotes(sessionId, ownerId, entryId, preset, signal);
      if (current.revision !== expected_revision && !current.paths.includes(path)) return current.revision;
    } catch { /* Leave the outcome uncertain when the read-back cannot confirm it. */ }
    throw new Error('删除结果未确认，可能已提交；请刷新文件列表核对，不要直接重试。', { cause: error });
  }
}

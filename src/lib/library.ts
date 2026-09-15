import { authRequest, AuthError } from './auth';

const HEX_32 = /^[0-9a-f]{32}$/;

export type EntryKind = 'note' | 'agent' | 'work_env' | 'file';
export type LibraryRole = 'owner' | 'subscribed';

export interface Library {
  id: string;
  name: string;
  role?: LibraryRole;
  created_at: string;
  updated_at: string;
}

export interface Entry {
  id: string;
  library_id: string;
  parent_id: string;
  kind: EntryKind;
  preset?: string;
  title: string;
  body?: string;
  content_type?: string;
  size?: number;
  created_at: string;
  updated_at: string;
}

export interface Publication {
  id: string;
  name: string;
  created_at: string;
  withdrawn?: boolean;
}


export interface SearchHit {
  id: string;
  title: string;
  snippet: string;
  source: string;
}


export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  created_at: string;
}

export interface ChatSession {
  id: string;
  entry_id: string;
  messages?: ChatMessage[];
  created_at: string;
  updated_at: string;
}

export interface ModelStatus {
  configured: boolean;
  source: 'custom' | 'product' | 'none';
  name?: string;
  quota: { limit: number; used: number; remaining: number };
}


function isTime(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isLibrary(value: unknown): value is Library {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && HEX_32.test(r.id) && typeof r.name === 'string' && isTime(r.created_at) && isTime(r.updated_at)
    && (r.role === undefined || r.role === 'owner' || r.role === 'subscribed');
}

function isEntry(value: unknown): value is Entry {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && HEX_32.test(r.id) && typeof r.library_id === 'string' && HEX_32.test(r.library_id)
    && typeof r.parent_id === 'string' && (r.kind === 'note' || r.kind === 'agent' || r.kind === 'work_env' || r.kind === 'file')
    && typeof r.title === 'string' && isTime(r.created_at) && isTime(r.updated_at)
    && (r.body === undefined || typeof r.body === 'string')
    && (r.preset === undefined || typeof r.preset === 'string')
    && (r.content_type === undefined || typeof r.content_type === 'string')
    && (r.size === undefined || typeof r.size === 'number');
}

function isPublication(value: unknown): value is Publication {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && HEX_32.test(r.id) && typeof r.name === 'string' && isTime(r.created_at)
    && (r.withdrawn === undefined || typeof r.withdrawn === 'boolean');
}



function isSession(value: unknown): value is ChatSession {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  if (typeof r.id !== 'string' || !HEX_32.test(r.id) || typeof r.entry_id !== 'string' || !HEX_32.test(r.entry_id) || !isTime(r.created_at) || !isTime(r.updated_at)) {
    return false;
  }
  if (r.messages === undefined) return true;
  if (!Array.isArray(r.messages)) return false;
  return r.messages.every(item => {
    if (!item || typeof item !== 'object') return false;
    const m = item as Record<string, unknown>;
    return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && isTime(m.created_at);
  });
}

function isModel(value: unknown): value is ModelStatus {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const quota = r.quota;
  if (!quota || typeof quota !== 'object') return false;
  const q = quota as Record<string, unknown>;
  return typeof r.configured === 'boolean' && (r.source === 'custom' || r.source === 'product' || r.source === 'none')

    && (r.name === undefined || typeof r.name === 'string')
    && typeof q.limit === 'number' && typeof q.used === 'number' && typeof q.remaining === 'number';
}

export async function listLibraries(signal?: AbortSignal): Promise<Library[]> {
  const data = await authRequest<{ libraries: unknown }>('/api/libraries', { signal });
  if (!Array.isArray(data.libraries) || !data.libraries.every(isLibrary)) throw new AuthError(503);
  return data.libraries;
}

export async function createLibrary(name: string, signal?: AbortSignal): Promise<Library> {
  const data = await authRequest<{ library: unknown }>('/api/libraries', { method: 'POST', body: JSON.stringify({ name }), signal });
  if (!isLibrary(data.library)) throw new AuthError(503);
  return data.library;
}

export async function listEntries(libraryId: string, signal?: AbortSignal): Promise<Entry[]> {
  const data = await authRequest<{ entries: unknown }>(`/api/libraries/${libraryId}/entries`, { signal });
  if (!Array.isArray(data.entries) || !data.entries.every(isEntry)) throw new AuthError(503);
  return data.entries;
}

export async function createEntry(libraryId: string, input: { kind: EntryKind; title: string; parent_id?: string; body?: string }, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/libraries/${libraryId}/entries`, { method: 'POST', body: JSON.stringify(input), signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function getEntry(id: string, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/entries/${id}`, { signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function patchEntry(id: string, patch: { title?: string; body?: string; parent_id?: string }, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch), signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function deleteEntry(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/entries/${id}`, { method: 'DELETE', signal });
}

export async function listSessions(entryId: string, signal?: AbortSignal): Promise<ChatSession[]> {
  const data = await authRequest<{ sessions: unknown }>(`/api/entries/${entryId}/sessions`, { signal });
  if (!Array.isArray(data.sessions) || !data.sessions.every(isSession)) throw new AuthError(503);
  return data.sessions;
}
export async function createSession(entryId: string, signal?: AbortSignal): Promise<ChatSession> {
  const data = await authRequest<{ session: unknown }>(`/api/entries/${entryId}/sessions`, { method: 'POST', signal });
  if (!isSession(data.session)) throw new AuthError(503);
  return data.session;
}

export async function getSession(id: string, signal?: AbortSignal): Promise<ChatSession> {
  const data = await authRequest<{ session: unknown }>(`/api/sessions/${id}`, { signal });
  if (!isSession(data.session)) throw new AuthError(503);
  return data.session;
}

export async function sendMessage(sessionId: string, content: string, signal?: AbortSignal): Promise<ChatSession> {
  const data = await authRequest<{ session: unknown }>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content }), signal });
  if (!isSession(data.session)) throw new AuthError(503);
  return data.session;
}


export async function publishLibrary(libraryId: string, signal?: AbortSignal): Promise<Publication> {
  const data = await authRequest<{ publication: unknown }>(`/api/libraries/${libraryId}/publish`, { method: 'POST', signal });
  if (!isPublication(data.publication)) throw new AuthError(503);
  return data.publication;
}

export async function listMarket(signal?: AbortSignal): Promise<Publication[]> {
  const data = await authRequest<{ publications: unknown }>('/api/market', { signal });
  if (!Array.isArray(data.publications) || !data.publications.every(isPublication)) throw new AuthError(503);
  return data.publications;
}

export async function subscribePublication(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/market/${id}/subscribe`, { method: 'POST', signal });
}

export async function listPublications(libraryId: string, signal?: AbortSignal): Promise<Publication[]> {
  const data = await authRequest<{ publications: unknown }>(`/api/libraries/${libraryId}/publications`, { signal });
  if (!Array.isArray(data.publications) || !data.publications.every(isPublication)) throw new AuthError(503);
  return data.publications;
}

export async function withdrawPublication(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/publications/${id}/withdraw`, { method: 'POST', signal });
}

export async function renameLibrary(id: string, name: string, signal?: AbortSignal): Promise<Library> {
  const data = await authRequest<{ library: unknown }>(`/api/libraries/${id}`, { method: 'PATCH', body: JSON.stringify({ name }), signal });
  if (!isLibrary(data.library)) throw new AuthError(503);
  return data.library;
}

export async function deleteLibrary(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/libraries/${id}`, { method: 'DELETE', signal });
}


export async function searchNotes(libraryId: string, query: string, signal?: AbortSignal): Promise<SearchHit[]> {
  const data = await authRequest<{ hits: unknown }>(`/api/libraries/${libraryId}/search?q=${encodeURIComponent(query)}`, { signal });
  if (!Array.isArray(data.hits)) throw new AuthError(503);
  return data.hits.filter((item): item is SearchHit => {
    if (!item || typeof item !== 'object') return false;
    const r = item as Record<string, unknown>;
    return typeof r.id === 'string' && HEX_32.test(r.id) && typeof r.title === 'string' && typeof r.snippet === 'string' && typeof r.source === 'string';
  });
}

export async function uploadFile(libraryId: string, file: File, parentId?: string, signal?: AbortSignal): Promise<Entry> {
  const body = new FormData();
  body.append('file', file);
  if (parentId) body.append('parent_id', parentId);
  const data = await authRequest<{ entry: unknown }>(`/api/libraries/${libraryId}/files`, { method: 'POST', body, signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function downloadFile(id: string, signal?: AbortSignal): Promise<void> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  const timeout = window.setTimeout(abort, 15000);
  try {
    const response = await fetch(`/api/entries/${id}/file`, { signal: controller.signal, credentials: 'same-origin', cache: 'no-store', redirect: 'error' });
    if (!response.ok) throw new AuthError(response.status);
    const blob = await response.blob();
    const match = /filename="([^"]+)"/.exec(response.headers.get('Content-Disposition') ?? '');
    const href = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = href;
    link.download = match?.[1] || 'file';
    link.click();
    URL.revokeObjectURL(href);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abort);
  }
}

export async function getModel(signal?: AbortSignal): Promise<ModelStatus> {
  const data = await authRequest<{ model: unknown }>('/api/account/model', { signal });
  if (!isModel(data.model)) throw new AuthError(503);
  return data.model;
}

export async function putModel(input: { base_url: string; api_key: string; model?: string }, signal?: AbortSignal): Promise<ModelStatus> {
  const data = await authRequest<{ model: unknown }>('/api/account/model', { method: 'PUT', body: JSON.stringify(input), signal });
  if (!isModel(data.model) && data.model && typeof data.model === 'object') {
    const r = data.model as Record<string, unknown>;
    return {
      configured: r.configured === true,
      source: r.source === 'custom' ? 'custom' : r.source === 'product' ? 'product' : 'none',

      name: typeof r.name === 'string' ? r.name : '',
      quota: { limit: 0, used: 0, remaining: 0 },
    };
  }
  if (!isModel(data.model)) throw new AuthError(503);
  return data.model;
}

export async function clearModel(signal?: AbortSignal): Promise<void> {
  await authRequest('/api/account/model', { method: 'DELETE', signal });
}

export function describeLibraryError(error: unknown): string {
  if (error instanceof AuthError) {
    const id = error.body?.error?.id;
    if (error.status === 401) return '登录状态已失效，请重新登录。';
    if (id === 'upstream_blocked') return '只接受公网 HTTPS 上游，内网和云元数据地址已被拒绝。';
    if (id === 'model_unconfigured') return '还没有可用的模型。请配置自己的上游，或确认产品 NewAPI 已就绪。';
    if (id === 'quota_exceeded') return '今日产品模型次数已用完。';
    if (id === 'upstream_unavailable') return '模型上游暂时不可用，请稍后重试。';
    if (id === 'invalid_model' || id === 'invalid_entry' || id === 'invalid_library' || id === 'invalid_search') return '提交内容不符合要求，请检查后重试。';
    if (id === 'library_read_only') return '接入的知识库是只读快照，不能改内容。';
    if (error.status === 403) return '接入的知识库是只读快照，不能改内容。';
    if (error.status === 404) return '未找到这条内容，可能已被删除。';
    if (error.status === 409) return '数量已达上限。';
    if (error.status === 429) return '操作有些频繁，请稍后再试。';
    if (error.status >= 500) return '知识库服务暂时不可用，请稍后重试。';

  }
  if (error instanceof Error && error.name === 'AbortError') return '请求已取消。';
  return '操作失败，请检查网络连接后重试。';
}

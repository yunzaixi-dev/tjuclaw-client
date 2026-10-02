import { authRequest, AuthError } from './auth';

const HEX_32 = /^[0-9a-f]{32}$/;

export type EntryKind = 'note' | 'rich_text' | 'agent' | 'work_env' | 'file' | 'folder';
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
  sort_order?: number;
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
  client_request_id?: string;
  /** Names of tools the Agent used before this reply. */
  tools?: string[];
  /** The reply's thinking and tool calls, in order. */
  steps?: TurnStep[];
  /** Notes the reply's turn created or changed, to link to. */
  notes?: NoteRef[];
  /** The user stopped the turn that wrote this reply. */
  interrupted?: boolean;
  created_at: string;
}

/** A note an Agent turn created or changed. */
export interface NoteRef {
  entry_id: string;
  library_id: string;
  title: string;
  change: 'created' | 'updated';
}

export interface TurnStep {
  kind: 'thinking' | 'tool';
  text?: string;
  /** A thinking step whose text the model said to the user before going on to call tools. */
  said?: boolean;
  name?: string;
  input?: string;
  output?: string;
  failed?: boolean;
  /** Lines a file write or edit added and removed. */
  added?: number;
  removed?: number;
}

/** Where a tool call of the running turn stands: its arguments are being written, it runs, or it ended. */
export type LiveStatus = 'writing' | 'running' | 'done' | 'failed';

/**
 * One entry of the running turn's timeline, as one poll reports it. `text` is
 * the entry's text from byte `from` on, and `next` the offset to ask from next
 * time.
 */
export interface LiveItem {
  i: number;
  kind: 'thinking' | 'text' | 'tool';
  text: string; from: number; next: number;
  name: string; input: string; status: LiveStatus;
  /** Lines written so far, while a file is being written. */
  lines: number;
  added: number; removed: number;
  output: string;
}

/**
 * The running turn as the server sees it: a timeline of thinking, text and
 * tool calls in the order they happened. A poll with a cursor carries only
 * the entries that changed.
 */
export interface LiveTurn {
  /** Changes whenever the turn changes; 0 while idle, null on a server without live output. */
  version: number | null;
  items: LiveItem[];
  /** How many entries the timeline has. */
  count: number;
  /** What the turn is waiting for (see `stageText`); '' on a server that does not say. */
  stage: string;
  /** How long the turn has been in that stage, in milliseconds. */
  stageMs: number;
  /** Estimated tokens the current model call has written, and over how long. */
  rateTokens: number;
  rateMs: number;
}
/** What the client has: the version, and the entry whose text may still grow with how much of it arrived. */
export interface LiveCursor { version: number; tail: number; at: number }

const liveKinds = ['thinking', 'text', 'tool'];
const liveStatuses = ['writing', 'running', 'done', 'failed'];

/**
 * Reads the running turn. With a cursor the server answers when the turn has
 * changed (or after about 15 seconds) and sends only what is new.
 */
export async function getLive(sessionId: string, cursor?: LiveCursor, signal?: AbortSignal): Promise<LiveTurn> {
  const query = cursor ? `?${new URLSearchParams({ version: String(cursor.version), tail: String(cursor.tail), at: String(cursor.at) })}` : '';
  const data = await authRequest<{ version?: unknown; items?: unknown; count?: unknown; stage?: { id?: unknown; ms?: unknown }; rate?: { tokens?: unknown; ms?: unknown } }>(
    `/api/sessions/${sessionId}/live${query}`, { signal }, 25000);
  const whole = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
  const words = (value: unknown) => typeof value === 'string' ? value : '';
  const items: LiveItem[] = [];
  for (const raw of Array.isArray(data.items) ? data.items : []) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    if (!Number.isSafeInteger(item.i) || (item.i as number) < 0 || !liveKinds.includes(item.kind as string)) continue;
    items.push({
      i: item.i as number, kind: item.kind as LiveItem['kind'],
      text: words(item.text), from: whole(item.from), next: whole(item.next),
      name: words(item.name), input: words(item.input),
      status: liveStatuses.includes(item.status as string) ? item.status as LiveStatus : 'running',
      lines: whole(item.lines), added: whole(item.added), removed: whole(item.removed), output: words(item.output),
    });
  }
  return {
    version: Number.isSafeInteger(data.version) ? data.version as number : null,
    items, count: whole(data.count),
    stage: typeof data.stage?.id === 'string' ? data.stage.id : '',
    stageMs: typeof data.stage?.ms === 'number' && data.stage.ms >= 0 ? data.stage.ms : 0,
    rateTokens: whole(data.rate?.tokens), rateMs: whole(data.rate?.ms),
  };
}

/**
 * Stops the session's running turn. The pending send still returns the reply,
 * with what the Agent had written so far. Rejects when no turn is running or
 * the server cannot stop it.
 */
export async function interruptSession(sessionId: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/sessions/${sessionId}/interrupt`, { method: 'POST', signal }, 20000);
}

/** Warms the session's sandbox ahead of the first message. Best effort. */
export async function prepareSession(sessionId: string): Promise<void> {
  await authRequest(`/api/sessions/${sessionId}/prepare`, { method: 'POST' }).catch(() => undefined);
}

function isStep(value: unknown): value is TurnStep {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const optional = (key: string) => r[key] === undefined || typeof r[key] === 'string';
  const lines = (key: string) => r[key] === undefined || (Number.isSafeInteger(r[key]) && (r[key] as number) >= 0);
  return (r.kind === 'thinking' || r.kind === 'tool') && optional('text') && optional('name') && optional('input')
    && optional('output') && (r.failed === undefined || typeof r.failed === 'boolean')
    && (r.said === undefined || typeof r.said === 'boolean') && lines('added') && lines('removed');
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
  choices?: string[];
  /** What the Agent can actually do on this server right now. */
  agent?: AgentCapabilities;
  quota: { limit: number; used: number; remaining: number };
  /** Rolling product-model limits; empty when unlimited or broker-managed. */
  windows?: QuotaWindow[];
  /** How heavily each product model's tokens count against the windows. */
  rates?: Record<string, number>;
}

export interface QuotaWindow {
  id: string;
  limit: number;
  used: number;
  remaining: number;
  /** What the numbers count: 'tokens' (weighted by the model's rate); absent on an older server that counted turns. */
  unit?: string;
  /** When the next counted use leaves the window. */
  resets_at?: string;
}

export { formatModelRate, formatQuotaUse, formatTokens, quotaShareLeft } from './quota-format.ts';

const quotaWindowNames: Record<string, string> = { '5h': '5 小时', '7d': '7 天' };
export const quotaWindowName = (id: string) => quotaWindowNames[id] ?? id;

/** A reset time as 今天/明天 HH:mm or M月D日 HH:mm, in the viewer's zone. */
export function formatQuotaReset(iso: string | undefined, now = new Date()): string {
  const at = iso ? new Date(iso) : null;
  if (!at || Number.isNaN(at.getTime())) return '';
  const time = at.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const day = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diff = Math.round((day(at) - day(now)) / 86400000);
  if (diff === 0) return `今天 ${time}`;
  if (diff === 1) return `明天 ${time}`;
  return `${at.getMonth() + 1}月${at.getDate()}日 ${time}`;
}

/** The first exhausted window, which is what blocks the next turn. */
export const exhaustedQuotaWindow = (status: Pick<ModelStatus, 'windows'> | null) =>
  status?.windows?.find(window => window.remaining <= 0) ?? null;

function isQuotaWindow(value: unknown): value is QuotaWindow {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.id === 'string' && typeof r.limit === 'number' && typeof r.used === 'number' && typeof r.remaining === 'number'
    && (r.unit === undefined || typeof r.unit === 'string')
    && (r.resets_at === undefined || typeof r.resets_at === 'string');
}

export interface AgentCapabilities {
  sandbox: boolean;
  tools: string[];
}

// Product models are presented under their TJUClaw names, not upstream IDs.
const productModelNames: Record<string, string> = {
  'deepseek-flash': '蓝色大肥鱼',
  'gpt-6-sol-lite': '太阳',
};

export function modelDisplayName(status: Pick<ModelStatus, 'source' | 'name'>): string {
  const name = status.name?.trim() ?? '';
  if (status.source === 'product') return productModelNames[name] ?? (name || 'TJUClaw 模型');
  if (status.source === 'custom') return name || '自定义模型';
  return '未配置';
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
    && typeof r.parent_id === 'string' && (r.kind === 'note' || r.kind === 'rich_text' || r.kind === 'agent' || r.kind === 'work_env' || r.kind === 'file' || r.kind === 'folder')
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
    return (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && isTime(m.created_at)
      && (m.client_request_id === undefined || (typeof m.client_request_id === 'string' && HEX_32.test(m.client_request_id)))
      && (m.tools === undefined || isStringList(m.tools))
      && (m.steps === undefined || (Array.isArray(m.steps) && m.steps.length <= 60 && m.steps.every(isStep)))
      && (m.notes === undefined || (Array.isArray(m.notes) && m.notes.every(isNoteRef)))
      && (m.interrupted === undefined || typeof m.interrupted === 'boolean');
  });
}

function isNoteRef(value: unknown): value is NoteRef {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.entry_id === 'string' && HEX_32.test(r.entry_id) && typeof r.library_id === 'string' && HEX_32.test(r.library_id)
    && typeof r.title === 'string' && (r.change === 'created' || r.change === 'updated');
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

function isAgentCapabilities(value: unknown): value is AgentCapabilities {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  return typeof r.sandbox === 'boolean' && isStringList(r.tools);
}

function isModel(value: unknown): value is ModelStatus {
  if (!value || typeof value !== 'object') return false;
  const r = value as Record<string, unknown>;
  const quota = r.quota;
  if (!quota || typeof quota !== 'object') return false;
  const q = quota as Record<string, unknown>;
  return typeof r.configured === 'boolean' && (r.source === 'custom' || r.source === 'product' || r.source === 'none')

    && (r.name === undefined || typeof r.name === 'string')
    && (r.choices === undefined || isStringList(r.choices))
    && (r.agent === undefined || isAgentCapabilities(r.agent))
    && (r.windows === undefined || (Array.isArray(r.windows) && r.windows.every(isQuotaWindow)))
    && (r.rates === undefined || (Boolean(r.rates) && typeof r.rates === 'object' && Object.values(r.rates as object).every(rate => typeof rate === 'number')))
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

export async function listFolders(libraryId: string, signal?: AbortSignal): Promise<Entry[]> {
  const data = await authRequest<{ folders: unknown }>(`/api/libraries/${libraryId}/folders`, { signal });
  if (!Array.isArray(data.folders) || !data.folders.every(isEntry)) throw new AuthError(503);
  return data.folders;
}

export async function createFolder(libraryId: string, title: string, parent_id?: string, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ folder: unknown }>(`/api/libraries/${libraryId}/folders`, {
    method: 'POST',
    body: JSON.stringify({ title, ...(parent_id ? { parent_id } : {}) }),
    signal,
  });
  if (!isEntry(data.folder) || data.folder.kind !== 'folder') throw new AuthError(503);
  return data.folder;
}

export async function getEntry(id: string, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/entries/${id}`, { signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function patchEntry(id: string, patch: { title?: string; body?: string; parent_id?: string; expected_updated_at?: string }, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/entries/${id}`, { method: 'PATCH', body: JSON.stringify(patch), signal });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function moveEntry(id: string, parent_id: string, expected_updated_at: string, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ entry: unknown }>(`/api/entries/${id}/move`, {
    method: 'POST', body: JSON.stringify({ parent_id, expected_updated_at }), signal,
  });
  if (!isEntry(data.entry)) throw new AuthError(503);
  return data.entry;
}

export async function patchFolder(id: string, patch: { title?: string; parent_id?: string }, signal?: AbortSignal): Promise<Entry> {
  const data = await authRequest<{ folder: unknown }>(`/api/folders/${id}`, { method: 'PATCH', body: JSON.stringify(patch), signal });
  if (!isEntry(data.folder) || data.folder.kind !== 'folder') throw new AuthError(503);
  return data.folder;
}

export async function deleteFolder(id: string, signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/folders/${id}`, { method: 'DELETE', signal });
}

export async function reorderEntries(libraryId: string, parent_id: string, ids: string[], signal?: AbortSignal): Promise<void> {
  await authRequest(`/api/libraries/${libraryId}/entries/order`, { method: 'PUT', body: JSON.stringify({ parent_id, ids }), signal });
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

/**
 * Reads the session once its running turn has settled. A reply is returned
 * before the notes the Agent wrote reach the library; this waits for that and
 * returns the reply with those notes linked.
 */
export async function getSettledSession(id: string, signal?: AbortSignal): Promise<ChatSession> {
  const data = await authRequest<{ session: unknown }>(`/api/sessions/${id}?settled=1`, { signal }, 90000);
  if (!isSession(data.session)) throw new AuthError(503);
  return data.session;
}

/** Validates a session returned by another route (the desktop local turn). */
export const isChatSession = (value: unknown): value is ChatSession => isSession(value);

export type AgentEffort = '' | 'low' | 'high';
const EFFORT_KEY = 'tjuclaw.agent.effort.v1';

/** The thinking strength for new turns: '' leaves it to the model. */
export function agentEffort(): AgentEffort {
  try {
    const value = localStorage.getItem(EFFORT_KEY);
    return value === 'low' || value === 'high' ? value : '';
  } catch { return ''; }
}

export function setAgentEffort(effort: AgentEffort) {
  try { if (effort) localStorage.setItem(EFFORT_KEY, effort); else localStorage.removeItem(EFFORT_KEY); } catch { /* lasts for this page */ }
}

export async function sendMessage(sessionId: string, content: string, clientRequestId: string, signal?: AbortSignal): Promise<ChatSession> {
  const effort = agentEffort();
  const data = await authRequest<{ session: unknown }>(`/api/sessions/${sessionId}/messages`, { method: 'POST', body: JSON.stringify({ content, client_request_id: clientRequestId, ...(effort ? { effort } : {}) }), signal }, 195000);
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

export async function chooseProductModel(name: string, signal?: AbortSignal): Promise<ModelStatus> {
  const data = await authRequest<{ model: unknown }>('/api/account/model', { method: 'PUT', body: JSON.stringify({ product_model: name }), signal });
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
    if (id === 'quota_5h_exceeded') return '5 小时内的 AI 额度已用完，恢复时间见输入框下方的模型按钮。';
    if (id === 'quota_7d_exceeded') return '7 天内的 AI 额度已用完，恢复时间见输入框下方的模型按钮。';
    if (id === 'quota_exceeded') return 'AI 额度已用完，请稍后再试。';
    if (id === 'local_docker_unavailable') return '没有检测到 Docker。请启动 Docker Desktop，或在「设置 → 模型」改回云端沙箱。';
    if (id === 'local_sandbox_unavailable') return '本机沙箱暂时无法运行这轮对话，请检查 Docker 后重试。';
    if (id === 'quota_unavailable') return '暂时无法读取模型额度，请稍后重试。';
    if (id === 'sandbox_unavailable') return 'Agent 沙箱暂时不可用，请稍后重试。';
    if (id === 'session_conflict') return '会话已在其他请求中更新，请刷新后重试。';
    if (id === 'entry_conflict') return '笔记已在其他设备更新，请先处理版本冲突。';
    if (id === 'message_request_conflict') return '这次重试的内容与原请求不同，请刷新会话后再发送。';
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

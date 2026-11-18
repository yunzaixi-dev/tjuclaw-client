import { AuthError } from './auth';
import { getSession, type ChatSession } from './library';
import { storeItem } from './safe-storage';

export type PendingChatRequest = { sessionId: string; id: string; content?: string; digest?: string };

function pendingChatKey(identity: string, sessionId: string) {
  return `tjuclaw.chat.pending.v1.${identity}.${sessionId}`;
}

export function readPendingChat(identity: string, sessionId: string): PendingChatRequest | null {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(pendingChatKey(identity, sessionId)) ?? '');
    if (!value || typeof value !== 'object') return null;
    const pending = value as Record<string, unknown>;
    return pending.sessionId === sessionId && typeof pending.id === 'string' && /^[0-9a-f]{32}$/.test(pending.id) &&
      !Object.hasOwn(pending, 'content') &&
      (pending.digest === undefined || typeof pending.digest === 'string' && /^[0-9a-f]{64}$/.test(pending.digest))
      ? pending as PendingChatRequest : null;
  } catch { return null; }
}

export function clearPendingChat(identity: string, sessionId: string, id: string) {
  if (readPendingChat(identity, sessionId)?.id === id) sessionStorage.removeItem(pendingChatKey(identity, sessionId));
}

export function savePendingChat(identity: string, sessionId: string, id: string, digest: string) {
  // In-memory retries still work when browser storage is disabled.
  storeItem(sessionStorage, pendingChatKey(identity, sessionId), JSON.stringify({ sessionId, id, digest }));
}

export async function chatDigest(content: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Returns the saved conversation through this turn, never across the next user message. */
export function savedTurnReply(session: ChatSession, sessionId: string, requestId: string, content: string): ChatSession | undefined {
  if (session.id !== sessionId) return;
  const messages = session.messages ?? [];
  const index = messages.findIndex(message => message.role === 'user' && message.client_request_id === requestId && message.content === content);
  const reply = index >= 0 ? messages[index + 1] : undefined;
  if (reply?.role !== 'assistant' || !reply.content.trim() || (reply.client_request_id && reply.client_request_id !== requestId)) return;
  return index + 2 === messages.length ? session : { ...session, messages: messages.slice(0, index + 2) };
}

export const CHAT_READBACK_WINDOW_MS = 200_000;

/** A timed-out POST can still finish. Retry only the read, within a fixed window. */
export async function pollSavedTurn(sessionId: string, requestId: string, content: string,
  signal: AbortSignal, current: () => boolean = () => true): Promise<ChatSession | undefined> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), CHAT_READBACK_WINDOW_MS);
  const bounded = AbortSignal.any([signal, timeout.signal]);
  try {
    while (!bounded.aborted && current()) {
      try {
        const session = await getSession(sessionId, bounded);
        if (bounded.aborted || !current()) return;
        const reply = savedTurnReply(session, sessionId, requestId, content);
        if (reply) return reply;
      } catch (error) {
        if (bounded.aborted || !current()) return;
        if (error instanceof AuthError && error.status < 500 && error.status !== 408 && error.status !== 429) throw error;
      }
      await new Promise<void>(resolve => {
        const finish = () => {
          clearTimeout(delay);
          bounded.removeEventListener('abort', finish);
          resolve();
        };
        const delay = setTimeout(finish, 3000);
        bounded.addEventListener('abort', finish, { once: true });
      });
    }
  } finally {
    clearTimeout(timer);
  }
}

export async function recoverSend(cause: unknown, sessionId: string, requestId: string, content: string,
  signal: AbortSignal, current: () => boolean): Promise<ChatSession | 'refused' | undefined> {
  const response = cause instanceof AuthError ? cause : undefined;
  const errorId = response?.body?.error?.id;
  const status = response?.status ?? 0;
  // Older gateways can emit the same 502 body after losing the POST response.
  if (status === 502 && response?.apiForwarded && errorId === 'upstream_unavailable') return 'refused';
  if ([400, 401, 403, 404].includes(status) || (errorId && [
    'local_docker_unavailable', 'local_sandbox_unavailable', 'model_unconfigured', 'quota_exceeded',
    'quota_5h_exceeded', 'quota_7d_exceeded', 'quota_unavailable', 'sandbox_model_unavailable', 'upstream_blocked',
  ].includes(errorId))) return 'refused';
  const pending = status === 0 || status === 408 || status === 502 || status === 504 || status >= 520 || (status >= 500 && !errorId);
  if (pending) return pollSavedTurn(sessionId, requestId, content, signal, current);
  if (signal.aborted || !current()) return;
  const session = await getSession(sessionId, signal);
  if (signal.aborted || !current()) return;
  return savedTurnReply(session, sessionId, requestId, content) ?? 'refused';
}

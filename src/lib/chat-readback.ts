import { AuthError } from './auth';
import { getSession, type ChatSession } from './library';

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
  // These are refused before a turn can be stored.
  const refused = cause instanceof AuthError ? cause.body?.error?.id : undefined;
  if (refused && ['local_docker_unavailable', 'local_sandbox_unavailable', 'model_unconfigured', 'quota_exceeded',
    'quota_5h_exceeded', 'quota_7d_exceeded', 'quota_unavailable', 'sandbox_model_unavailable', 'upstream_blocked'].includes(refused)) return 'refused';
  const status = cause instanceof AuthError ? cause.status : 0;
  const pending = status === 0 || status === 502 || status === 504 || status === 524;
  if (pending) return pollSavedTurn(sessionId, requestId, content, signal, current);
  if (signal.aborted || !current()) return;
  const session = await getSession(sessionId, signal);
  if (signal.aborted || !current()) return;
  return savedTurnReply(session, sessionId, requestId, content) ?? 'refused';
}
